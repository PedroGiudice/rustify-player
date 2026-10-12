# Crate fase 1: fontes por job e SoundCloud de ponta a ponta — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma busca no Crate devolve Soulseek e SoundCloud lado a lado; uma faixa do SoundCloud com download nativo entra no acervo pelo arquivo original do produtor, convertida para FLAC, com tags confirmadas pelo CEO, indexada, embeddada e com letra, pelo mesmo funil do Soulseek.

**Architecture:** O `DownloadJob` ganha `source: Source` (Soulseek | SoundCloud | Bandcamp) e `meta: ConfirmedMeta`; o coordinator `slsk-coord` continua escritor único do board e dono do funil final (`stage_and_ingest`), mas o trabalho bloqueante das fontes novas (download HTTP, sondagem, conversão com ffmpeg, tags com lofty, capa) roda num worker próprio (`sc-worker`) que devolve eventos por canal, no padrão do worker de letras. Um crate novo `soundcloud-client` (puro, `ureq`) fala com a API v2. O frontend ganha a seção SoundCloud na busca, o card de confirmação e o status das fontes.

**Tech Stack:** Rust 2021 (rust-version 1.78), Tauri 2.11, `ureq 2` + `rustls`, `lofty 0.25`, `image 0.25`, `ffmpeg`/`ffprobe` externos, SolidJS + vitest, CSS em `extractor-lab.css`.

**Spec:** `docs/superpowers/specs/2026-10-12-crate-fontes-soundcloud-bandcamp-design.md` (seções 2, 3, 4, 5, 7 e 8; a seção 6, Bandcamp, é a fase 2 e fica fora deste plano).

## Global Constraints

- Texto de UI, mensagens de erro e comentários em PT-BR com acentuação completa, sem emoji.
- CSP de `tauri.conf.json` não muda: todo tráfego externo sai do Rust. Capa do card chega como data URL.
- Nada de CDN ou host externo no frontend. Ícones só Lucide (`ICONS`).
- CSS: só tokens do tema/`:root` em `src/styles/extractor-lab.css`; `tabular-nums` em número que muda; sem modal.
- `slsk-coord` nunca faz I/O de rede ou conversão: isso é do worker. Comandos com resposta continuam respondendo em menos de 2 s.
- Segredos (token do SoundCloud) nunca em log, `Debug` ou evento IPC. Lidos do arquivo no momento do uso.
- Só `.flac` entra em `~/Music`. MP3 abaixo de 300 kbps estimados/medidos não baixa (`LowBitrate`).
- Commits atômicos, mensagem `<tipo>(<escopo>): <descrição>`, com a linha `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Não rodar `release.sh` até o fim do plano. `cargo test -p <crate>` e `npm test` por task são obrigatórios.
- Workspace Rust: `cd /home/opc/rustify-player/src-tauri` para todo `cargo`. Frontend: `cd /home/opc/rustify-player` para `npm`.

## Review Focus

1. **Token expirado no meio de um download** (401 na URL de redirecionamento): o job deve virar `Failed{retryable:false}` com "token do SoundCloud recusado", nunca ficar em `Downloading` eterno. Teste em Task 6 (`fake_sc_download_401_falha_sem_retry`). **Revisto no review da Task 6:** o token só é julgado na sondagem (`NoToken` → `Failed{retryable:false}` com "token do SoundCloud recusado", teste `sondagem_401_falha_sem_retry`). O download vai para a URL assinada do CDN SEM `Authorization` (`soundcloud-client/src/http.rs`, `download`), então 401/403 ali é link expirado ou bloqueio: vira `Failed{retryable:true}` com "o SoundCloud recusou o link do original (expirado ou bloqueado); tente de novo" (a nova tentativa sonda de novo e ganha outro link). Teste `download_401_do_cdn_falha_com_retry_sem_culpar_o_token`.
2. **Original com extensão enganosa** (`.wav` que é MP3 por dentro, ou `.mp3` VBR a 200 kbps): a decisão final vem do `ffprobe` do arquivo baixado, não da extensão. Testes em Task 4 (`probe_media_mp3_128_vs_320`) e Task 6 (`mp3_abaixo_de_300_rejeita_low_bitrate`).
3. **Dois cliques em Baixar na mesma faixa** (ou a mesma faixa já em voo): `job_id` determinístico por `track_id` e `create_or_get_job` devolvem o job existente sem segundo download. Teste em Task 2 (`download_external_e_idempotente`).
4. **ffmpeg ausente ou quebrado** (sai 0 com arquivo vazio, lição do S24): `to_flac` valida o FLAC de saída por `parse_flac` e por duração; falha vira `Failed{retryable:false}` com "ffmpeg ausente/falhou". Testes em Task 4 (`to_flac_rejeita_saida_vazia`) e Task 5 (status `ffmpeg: false`).
5. **Metadado confirmado com caractere proibido** (`Título: Remix?`): `sanitize_component` passa a trocar `: " * ? < > |` por `_`, e a pasta canônica fica válida no Android. Teste em Task 5 (`sanitize_component_android_safe`).

---

## Mapa de arquivos

| Ação | Arquivo | Responsabilidade |
|---|---|---|
| Modificar | `src-tauri/src/slsk/board.rs` | `Source`, `ConfirmedMeta`, `FormatIn`, `WaitReason`, estados novos, `job_id` por origem, `DownloadJob` migrado |
| Modificar | `src-tauri/src/slsk/coordinator.rs` | tarefas novas, canal do worker, `PersistedJob` com `source`, reconcile e tetos por origem |
| Criar | `src-tauri/crates/soundcloud-client/` | cliente puro da API v2 (busca, resolve, sondagem do original, download) com fixtures |
| Criar | `src-tauri/crates/library-indexer/src/transcode.rs` | `ffprobe`/`ffmpeg`: sondagem de mídia e conversão para FLAC |
| Criar | `src-tauri/crates/library-indexer/src/tagwrite.rs` | escrita de tags e capa em FLAC com `lofty` |
| Modificar | `src-tauri/crates/library-indexer/src/cover.rs` | `resize_cover_jpeg` |
| Modificar | `src-tauri/crates/slskd-client/src/stage_plan.rs` | `sanitize_component` com os caracteres do Android |
| Criar | `src-tauri/src/slsk/sources.rs` | `SourcesConfig` (arquivo + env), leitura de token, `SourcesStatus` |
| Criar | `src-tauri/src/slsk/sc_worker.rs` | thread `sc-worker`: download → sondagem → conversão → tags → capa → `Done` |
| Modificar | `src-tauri/src/slsk/mod.rs` | comandos `crate_*`, wiring do worker e da config |
| Modificar | `src-tauri/src/desktop.rs` | registro dos comandos novos |
| Modificar | `src-tauri/Cargo.toml`, `crates/library-indexer/Cargo.toml` | `lofty`, membro `soundcloud-client` |
| Modificar | `src/tauri.ts` | tipos e wrappers novos |
| Criar | `src/lib/trackMetaGuess.ts` (+ `.test.ts`) | sugestão de artista/título/ano a partir da API |
| Modificar | `src/views/Crate.tsx` (+ `Crate.test.tsx`) | seção SoundCloud, card, status das fontes, fila |
| Modificar | `src/styles/extractor-lab.css` | `.crate-src`, `.crate-card`, `.crate-fmt`, `.crate-avail` |
| Modificar | `docs/soulseek/manual-qa.md`, `CLAUDE.md`, `src-tauri/tauri.conf.json` (bump) | QA e documentação viva |

---

### Task 1: Board com origem, metadado confirmado e estados novos

**Files:**
- Modify: `src-tauri/src/slsk/board.rs`
- Test: `src-tauri/src/slsk/board.rs` (módulo `tests` existente, linha ~355)

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "snake_case", tag = "kind")]
  pub enum Source {
      Soulseek { username: String, remote_filename: String, size: u64 },
      SoundCloud { track_id: u64, permalink_url: String },
      Bandcamp { item_type: String, item_id: u64, url: String },
  }
  impl Source { pub fn kind(&self) -> &'static str; pub fn label(&self) -> String; }
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
  pub struct ConfirmedMeta { pub artist: String, pub title: String, pub album: String, pub year: Option<u32>, pub label: Option<String> }
  #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
  #[serde(rename_all = "snake_case")]
  pub enum FormatIn { Flac, Wav24, Wav16, Aiff, Mp3_320 }
  #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
  #[serde(rename_all = "snake_case")]
  pub enum WaitReason { Purchase, EmailLink }
  // JobState ganha: Waiting { reason: WaitReason, url: String, since_secs: u64 }
  // RejectReason ganha: LowBitrate { kbps: u32 }, NoDownload
  pub fn job_id(source: &Source) -> String;
  pub struct DownloadJob { job_id, source: Source, meta: ConfirmedMeta, format_in: Option<FormatIn>, tracks: u16, display, dest_playlist, state, quality_label, alternates, tried_source_ids, created_at }
  impl DownloadJob { pub fn soulseek(&self) -> Option<(&str, &str, u64)> }
  ```

- [ ] **Step 1: Escrever os testes que falham**

No módulo `tests` de `board.rs`, trocar o helper `job(id, state)` e acrescentar:

```rust
fn job(id: &str, state: JobState) -> DownloadJob {
    DownloadJob {
        job_id: id.to_string(),
        source: Source::Soulseek {
            username: "peer".into(),
            remote_filename: format!("{id}.flac"),
            size: 1,
        },
        meta: ConfirmedMeta::default(),
        format_in: None,
        tracks: 1,
        display: id.to_string(),
        dest_playlist: "Rap & Hip-Hop".into(),
        state,
        quality_label: String::new(),
        alternates: Vec::new(),
        tried_source_ids: Vec::new(),
        created_at: 0,
    }
}

#[test]
fn job_id_e_determinista_por_origem() {
    let a = Source::Soulseek { username: "u".into(), remote_filename: "f.flac".into(), size: 1 };
    let b = Source::SoundCloud { track_id: 42, permalink_url: "https://soundcloud.com/x/y".into() };
    assert_eq!(job_id(&a), job_id(&a));
    assert_ne!(job_id(&a), job_id(&b));
    // size não participa da identidade: a mesma faixa com size diferente é o mesmo job
    let a2 = Source::Soulseek { username: "u".into(), remote_filename: "f.flac".into(), size: 9 };
    assert_eq!(job_id(&a), job_id(&a2));
    // compatibilidade: o hash do Soulseek continua o de "{username}\u{1}{remote_filename}"
    assert_eq!(job_id(&a), legacy_job_id("u", "f.flac"));
}

#[test]
fn waiting_entra_de_queued_enqueued_downloading_e_sai_para_enqueued() {
    let w = JobState::Waiting { reason: WaitReason::Purchase, url: "https://x".into(), since_secs: 0 };
    assert!(can_transition(&JobState::Queued, &w));
    assert!(can_transition(&JobState::Enqueued { queue_position: None }, &w));
    assert!(can_transition(&JobState::Downloading { pct: 1.0, bps: 1, eta_s: None }, &w));
    assert!(can_transition(&w, &JobState::Enqueued { queue_position: None }));
    assert!(can_transition(&w, &JobState::Canceled));
    assert!(can_transition(&w, &JobState::Failed { reason: "x".into(), retryable: false }));
    assert!(!can_transition(&w, &JobState::Ready { track_id: "1".into() }));
    assert!(!is_terminal(&w));
    assert!(!is_in_flight(&w), "waiting não ocupa vaga de transferência");
}

#[test]
fn reject_reasons_novos_serializam_snake_case() {
    let v = serde_json::to_value(RejectReason::LowBitrate { kbps: 128 }).unwrap();
    assert_eq!(v, serde_json::json!({ "low_bitrate": { "kbps": 128 } }));
    let v = serde_json::to_value(RejectReason::NoDownload).unwrap();
    assert_eq!(v, serde_json::json!("no_download"));
}

#[test]
fn source_serializa_com_kind_e_round_trip() {
    let s = Source::SoundCloud { track_id: 7, permalink_url: "https://soundcloud.com/a/b".into() };
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v["kind"], "sound_cloud");
    let back: Source = serde_json::from_value(v).unwrap();
    assert_eq!(back, s);
    assert_eq!(s.kind(), "sound_cloud");
}
```

`legacy_job_id` é um helper só de teste: copia a implementação antiga (`format!("{username}\u{1}{remote_filename}")` no `DefaultHasher`). Serve para provar que jobs Soulseek persistidos em `slsk_jobs.json` continuam com o mesmo id.

- [ ] **Step 2: Rodar para ver falhar**

Run: `cargo test -p rustify-player --lib slsk::board -- --nocapture`
Expected: erro de compilação (`Source`, `ConfirmedMeta`, `WaitReason` não existem).

- [ ] **Step 3: Implementar**

Em `board.rs`:

```rust
/// Origem de um job. `tag = "kind"` no wire: `{"kind":"sound_cloud","track_id":...}`.
/// Só a variante Soulseek carrega o que o slskd precisa; as outras carregam
/// o identificador estável da fonte. Ver spec §2.1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Source {
    Soulseek { username: String, remote_filename: String, size: u64 },
    SoundCloud { track_id: u64, permalink_url: String },
    Bandcamp { item_type: String, item_id: u64, url: String },
}

impl Source {
    pub fn kind(&self) -> &'static str {
        match self {
            Source::Soulseek { .. } => "soulseek",
            Source::SoundCloud { .. } => "sound_cloud",
            Source::Bandcamp { .. } => "bandcamp",
        }
    }

    /// Texto curto para a UI (subtítulo da fila): peer ou link.
    pub fn label(&self) -> String {
        match self {
            Source::Soulseek { username, .. } => username.clone(),
            Source::SoundCloud { permalink_url, .. } => permalink_url.clone(),
            Source::Bandcamp { url, .. } => url.clone(),
        }
    }

    /// Chave de identidade (sem `size`: a mesma faixa com tamanho novo é o mesmo job).
    fn identity(&self) -> String {
        match self {
            Source::Soulseek { username, remote_filename, .. } => format!("{username}\u{1}{remote_filename}"),
            Source::SoundCloud { track_id, .. } => format!("sound_cloud\u{1}{track_id}"),
            Source::Bandcamp { item_type, item_id, .. } => format!("bandcamp\u{1}{item_type}\u{1}{item_id}"),
        }
    }
}

/// O que o CEO confirmou no card antes do download (spec §2.1). Vazio para
/// jobs Soulseek: as tags vêm do arquivo do peer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub struct ConfirmedMeta {
    pub artist: String,
    pub title: String,
    pub album: String,
    pub year: Option<u32>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormatIn { Flac, Wav24, Wav16, Aiff, Mp3_320 }

impl FormatIn {
    pub fn is_lossy(self) -> bool { matches!(self, FormatIn::Mp3_320) }
    pub fn label(self) -> &'static str {
        match self {
            FormatIn::Flac => "FLAC", FormatIn::Wav24 => "WAV 24 bit", FormatIn::Wav16 => "WAV",
            FormatIn::Aiff => "AIFF", FormatIn::Mp3_320 => "MP3 320",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WaitReason { Purchase, EmailLink }
```

`RejectReason` ganha `LowBitrate { kbps: u32 }` e `NoDownload`; passa a derivar `Deserialize` também (o `PersistedJob` da Task 2 não persiste terminais, mas o round-trip de teste exige). `JobState` ganha `Waiting { reason: WaitReason, url: String, since_secs: u64 }` e `tag()` devolve `"waiting"`. `can_transition` ganha as arestas:

```rust
            | ("queued", "waiting")
            | ("enqueued", "waiting")
            | ("downloading", "waiting")
            | ("waiting", "enqueued")
            | ("waiting", "canceled")
            | ("waiting", "failed")
```

`IN_FLIGHT` não inclui `"waiting"`. `job_id` vira:

```rust
pub fn job_id(source: &Source) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.identity().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
```

`DownloadJob` perde `username`, `remote_filename` e `size` e ganha `source: Source`, `meta: ConfirmedMeta`, `format_in: Option<FormatIn>`, `tracks: u16`. Acrescentar:

```rust
impl DownloadJob {
    /// (username, remote_filename, size) quando a origem é Soulseek.
    pub fn soulseek(&self) -> Option<(&str, &str, u64)> {
        match &self.source {
            Source::Soulseek { username, remote_filename, size } => Some((username, remote_filename, *size)),
            _ => None,
        }
    }
}
```

Atualizar os três `DownloadJob {` dos testes de `board.rs` para o helper novo.

- [ ] **Step 4: Rodar os testes do board**

Run: `cargo test -p rustify-player --lib slsk::board`
Expected: todos passam. O resto do crate ainda não compila (coordinator usa os campos antigos): é esperado e a Task 2 resolve. Use `cargo test -p rustify-player --lib slsk::board --no-fail-fast 2>&1 | tail -20` para ver só este módulo; se o compilador parar antes por erros do coordinator, aplique temporariamente `#[cfg(any())]` NÃO. Em vez disso, faça a Task 2 na mesma branch antes de commitar os dois juntos se o crate não compilar isolado.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/slsk/board.rs
git commit -m "feat(crate): job com origem (Source), meta confirmada e estado waiting no board"
```

---

### Task 2: Coordinator por origem, tarefas e canal do worker

**Files:**
- Modify: `src-tauri/src/slsk/coordinator.rs` (structs 60-220, `PersistedJob` 206-219, `reconcile_boot` 505-566, `create_or_get_job` 876-910, `enqueue_job`, `handle_task_download`, `cancel_job` 1055-1075, `poll_active_transfers_once` 1095-1147, `fail_network_dependent_jobs`, `promote_queued`, `run_loop` 1504-1538, `handle_task`, `spawn_coordinator` 1590-1640, testes 1653+)
- Test: módulo `tests` de `coordinator.rs`

**Interfaces:**
- Consumes: `board::{Source, ConfirmedMeta, FormatIn, job_id, DownloadJob::soulseek}` (Task 1).
- Produces:
  ```rust
  pub enum SlskTask { ..., DownloadExternal { source: Source, meta: ConfirmedMeta, dest: String, reply: Sender<Result<String, String>> } }
  /// Enviado ao worker de uma fonte externa.
  pub struct FetchTask { pub job_id: String, pub source: Source, pub meta: ConfirmedMeta, pub playlist: String, pub incoming_dir: PathBuf }
  /// Devolvido pelo worker.
  pub enum FetchEvent {
      Started { job_id: String },
      Progress { job_id: String, pct: f32, bps: u64, eta_s: Option<u32> },
      Done { job_id: String, flac_path: PathBuf, format_in: FormatIn },
      Rejected { job_id: String, reason: RejectReason, quarantine: Option<PathBuf> },
      Failed { job_id: String, reason: String, retryable: bool },
  }
  impl Coordinator { fn with_fetch_channels(self, tx: Sender<FetchTask>, rx: Receiver<FetchEvent>) -> Self; }
  pub const MAX_ACTIVE_SOULSEEK: usize = 3; pub const MAX_ACTIVE_SOUNDCLOUD: usize = 2; pub const MAX_ACTIVE_BANDCAMP: usize = 1;
  ```

- [ ] **Step 1: Escrever os testes que falham**

No módulo `tests` de `coordinator.rs` (reaproveitar os helpers existentes: `FakeSlskd`, `empty_owned_index`, o construtor `Coordinator::new(...)` usado nos testes atuais):

```rust
fn sc_source(id: u64) -> Source {
    Source::SoundCloud { track_id: id, permalink_url: format!("https://soundcloud.com/a/{id}") }
}

fn meta(artist: &str, title: &str) -> ConfirmedMeta {
    ConfirmedMeta { artist: artist.into(), title: title.into(), album: title.into(), year: Some(2024), label: None }
}

#[test]
fn download_external_e_idempotente() {
    let (c, _tmp) = test_coordinator();           // helper já existente nos testes
    let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
    let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
    let c = c.with_fetch_channels(ftx, erx);
    let (r1, rx1) = crossbeam_channel::bounded(1);
    c.handle_task(SlskTask::DownloadExternal { source: sc_source(7), meta: meta("DJ Arana", "Festa"), dest: "Funk Brasileiro".into(), reply: r1 });
    let id1 = rx1.recv().unwrap().unwrap();
    let (r2, rx2) = crossbeam_channel::bounded(1);
    c.handle_task(SlskTask::DownloadExternal { source: sc_source(7), meta: meta("DJ Arana", "Festa"), dest: "Funk Brasileiro".into(), reply: r2 });
    let id2 = rx2.recv().unwrap().unwrap();
    assert_eq!(id1, id2);
    assert_eq!(frx.try_iter().count(), 1, "um único FetchTask para o worker");
    let job = c.board.get(&id1).unwrap();
    assert_eq!(job.state, JobState::Enqueued { queue_position: None });
    assert_eq!(job.meta.artist, "DJ Arana");
}

#[test]
fn eventos_do_worker_movem_o_job() {
    let (c, tmp) = test_coordinator();
    let (ftx, _frx) = crossbeam_channel::bounded::<FetchTask>(16);
    let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
    let c = c.with_fetch_channels(ftx, erx);
    let (r, rx) = crossbeam_channel::bounded(1);
    c.handle_task(SlskTask::DownloadExternal { source: sc_source(1), meta: meta("A", "T"), dest: "P".into(), reply: r });
    let id = rx.recv().unwrap().unwrap();
    etx.send(FetchEvent::Progress { job_id: id.clone(), pct: 40.0, bps: 1000, eta_s: Some(3) }).unwrap();
    c.drain_fetch_events(Instant::now());
    assert!(matches!(c.board.get(&id).unwrap().state, JobState::Downloading { pct, .. } if (pct - 40.0).abs() < 0.01));
    // Done com um FLAC real de fixture → stage_and_ingest → Indexing/Ready pelo ingest falso
    let flac = tmp.path().join("in.flac");
    std::fs::copy(fixture_flac(), &flac).unwrap();   // fixture já usada pelos testes de stage
    etx.send(FetchEvent::Done { job_id: id.clone(), flac_path: flac, format_in: FormatIn::Wav16 }).unwrap();
    c.drain_fetch_events(Instant::now());
    let job = c.board.get(&id).unwrap();
    assert!(matches!(job.state, JobState::Ready { .. } | JobState::Indexing), "estado: {:?}", job.state);
    assert_eq!(job.format_in, Some(FormatIn::Wav16));
}

#[test]
fn rejected_do_worker_vira_rejected_no_board() {
    let (c, _tmp) = test_coordinator();
    let (ftx, _frx) = crossbeam_channel::bounded::<FetchTask>(16);
    let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
    let c = c.with_fetch_channels(ftx, erx);
    let (r, rx) = crossbeam_channel::bounded(1);
    c.handle_task(SlskTask::DownloadExternal { source: sc_source(2), meta: meta("A", "T"), dest: "P".into(), reply: r });
    let id = rx.recv().unwrap().unwrap();
    etx.send(FetchEvent::Rejected { job_id: id.clone(), reason: RejectReason::LowBitrate { kbps: 128 }, quarantine: None }).unwrap();
    c.drain_fetch_events(Instant::now());
    assert_eq!(c.board.get(&id).unwrap().state, JobState::Rejected { reason: RejectReason::LowBitrate { kbps: 128 } });
}

#[test]
fn teto_por_origem_nao_mistura_fontes() {
    let (c, _tmp) = test_coordinator();
    let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
    let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
    let c = c.with_fetch_channels(ftx, erx);
    for i in 0..4u64 {
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(10 + i), meta: meta("A", &format!("T{i}")), dest: "P".into(), reply: r });
        rx.recv().unwrap().unwrap();
    }
    assert_eq!(frx.try_iter().count(), MAX_ACTIVE_SOUNDCLOUD, "só 2 vão para o worker; os outros ficam Queued");
    let queued = c.board.snapshot().into_iter().filter(|j| j.state == JobState::Queued).count();
    assert_eq!(queued, 2);
}

#[test]
fn slskd_fora_do_ar_nao_falha_job_externo() {
    let (c, _tmp) = test_coordinator();       // FakeSlskd configurado para api.downloads() falhar
    let (ftx, _frx) = crossbeam_channel::bounded::<FetchTask>(16);
    let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
    let c = c.with_fetch_channels(ftx, erx);
    let (r, rx) = crossbeam_channel::bounded(1);
    c.handle_task(SlskTask::DownloadExternal { source: sc_source(3), meta: meta("A", "T"), dest: "P".into(), reply: r });
    let id = rx.recv().unwrap().unwrap();
    c.fail_network_dependent_jobs("slskd inalcancavel");
    assert_eq!(c.board.get(&id).unwrap().state, JobState::Enqueued { queue_position: None });
}

#[test]
fn persisted_job_externo_volta_queued_no_boot() {
    let (c, tmp) = test_coordinator();
    let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
    let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
    let c = c.with_fetch_channels(ftx, erx);
    let (r, rx) = crossbeam_channel::bounded(1);
    c.handle_task(SlskTask::DownloadExternal { source: sc_source(5), meta: meta("A", "T"), dest: "P".into(), reply: r });
    let id = rx.recv().unwrap().unwrap();
    frx.try_iter().count();
    c.board.transition(&id, JobState::Downloading { pct: 10.0, bps: 1, eta_s: None });
    c.save_jobs();
    // segundo coordinator lendo o mesmo jobs_path
    let (c2, _) = test_coordinator_at(tmp.path());
    let (ftx2, frx2) = crossbeam_channel::bounded::<FetchTask>(16);
    let (_e2, erx2) = crossbeam_channel::unbounded::<FetchEvent>();
    let c2 = c2.with_fetch_channels(ftx2, erx2);
    c2.reconcile_boot(unix_now());
    let job = c2.board.get(&id).expect("job restaurado");
    assert_eq!(job.meta.artist, "A");
    assert!(matches!(job.state, JobState::Queued | JobState::Enqueued { .. }));
    assert_eq!(frx2.try_iter().count(), 1, "re-despachado ao worker no boot");
}
```

`test_coordinator_at(dir)` é uma variação do helper existente que recebe o diretório (para reusar o `jobs_path`); se o helper atual já expõe o `TempDir`, basta construir o segundo `Coordinator::new` com o mesmo `jobs_path`.

- [ ] **Step 2: Rodar para ver falhar**

Run: `cargo test -p rustify-player --lib slsk::coordinator 2>&1 | head -40`
Expected: erros de compilação (`DownloadExternal`, `FetchTask`, campos antigos).

- [ ] **Step 3: Implementar**

1. Tipos novos perto de `SlskTask`:

```rust
pub struct FetchTask {
    pub job_id: String,
    pub source: Source,
    pub meta: ConfirmedMeta,
    pub playlist: String,
    /// `<music_root>/.rustify-incoming` — o worker grava `<job_id>.<ext>` e `<job_id>.flac` aqui.
    pub incoming_dir: PathBuf,
}

pub enum FetchEvent {
    Started { job_id: String },
    Progress { job_id: String, pct: f32, bps: u64, eta_s: Option<u32> },
    Done { job_id: String, flac_path: PathBuf, format_in: FormatIn },
    Rejected { job_id: String, reason: RejectReason, quarantine: Option<PathBuf> },
    Failed { job_id: String, reason: String, retryable: bool },
}

pub const MAX_ACTIVE_SOULSEEK: usize = 3;
pub const MAX_ACTIVE_SOUNDCLOUD: usize = 2;
pub const MAX_ACTIVE_BANDCAMP: usize = 1;

fn max_active_for(kind: &str) -> usize {
    match kind { "soulseek" => MAX_ACTIVE_SOULSEEK, "sound_cloud" => MAX_ACTIVE_SOUNDCLOUD, _ => MAX_ACTIVE_BANDCAMP }
}
```

Remover a const `MAX_ACTIVE_TRANSFERS` e trocar os usos por `max_active_for("soulseek")`.

2. `Coordinator` ganha `fetch_tx: Option<Sender<FetchTask>>`, `fetch_rx: Option<Receiver<FetchEvent>>` e `with_fetch_channels`. `JobBoard` ganha `in_flight_count_for(kind: &str) -> usize` (filtra `is_in_flight` e `j.source.kind() == kind`), em `board.rs`.

3. `PersistedJob` vira:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedJob {
    job_id: String,
    #[serde(default = "legacy_source_placeholder")]
    source: Source,
    // compatibilidade com slsk_jobs.json anterior (username/remote_filename soltos):
    #[serde(default)] username: String,
    #[serde(default)] remote_filename: String,
    #[serde(default)] meta: ConfirmedMeta,
    #[serde(default = "one")] tracks: u16,
    dest_playlist: String,
    #[serde(default)] alternates: Vec<Candidate>,
    #[serde(default)] quality_label: String,
    created_at: i64,
}
fn one() -> u16 { 1 }
fn legacy_source_placeholder() -> Source { Source::Soulseek { username: String::new(), remote_filename: String::new(), size: 0 } }
```

Em `load_persisted_jobs`, depois do parse: se `source` for o placeholder (username vazio) e `username` legado não for vazio, reconstruir `Source::Soulseek { username, remote_filename, size: 0 }`. `save_jobs` grava `source`, `meta`, `tracks` (e deixa `username`/`remote_filename` vazios).

4. `reconcile_boot`: para `pj.source` Soulseek, o bloco atual (usando `soulseek()`); para as outras origens, `upsert` com `state: JobState::Queued` e, se houver vaga (`in_flight_count_for(kind) < max_active_for(kind)`), `dispatch_fetch(&job)`; `Waiting` persistido é restaurado como está (o `PersistedJob` precisa guardar o estado `waiting` com `reason`/`url`: acrescentar `#[serde(default)] waiting: Option<(WaitReason, String)>`).

5. `create_or_get_job` passa a receber `source: Source, meta: ConfirmedMeta, display: String, quality_label: String, alternates, dest` e usar `job_id(&source)`. O chamador Soulseek monta `Source::Soulseek` a partir do `candidate`.

6. Novo handler:

```rust
fn handle_task_download_external(&self, source: Source, meta: ConfirmedMeta, dest: &str, reply: Sender<Result<String, String>>) {
    if !is_valid_playlist_name(dest) {
        let _ = reply.send(Err("destino de playlist invalido".to_string()));
        return;
    }
    if meta.artist.trim().is_empty() || meta.title.trim().is_empty() {
        let _ = reply.send(Err("artista e titulo sao obrigatorios".to_string()));
        return;
    }
    let display = format!("{} - {}", meta.artist, meta.title);
    let (job_id, is_new) = self.create_or_get_job(source.clone(), meta, display, String::new(), Vec::new(), dest);
    let _ = reply.send(Ok(job_id.clone()));
    if !is_new { return; }
    self.promote_external(source.kind());
}

/// Despacha jobs `Queued` da origem `kind` ao worker enquanto houver vaga.
fn promote_external(&self, kind: &str) {
    while self.board.in_flight_count_for(kind) < max_active_for(kind) {
        let next = self.board.snapshot().into_iter().find(|j| j.state == JobState::Queued && j.source.kind() == kind);
        let Some(job) = next else { break };
        self.dispatch_fetch(&job);
    }
}

fn dispatch_fetch(&self, job: &DownloadJob) {
    let Some(tx) = &self.fetch_tx else {
        self.board.transition(&job.job_id, JobState::Failed { reason: "fonte externa indisponivel".into(), retryable: true });
        self.mark_dirty();
        return;
    };
    let task = FetchTask {
        job_id: job.job_id.clone(),
        source: job.source.clone(),
        meta: job.meta.clone(),
        playlist: job.dest_playlist.clone(),
        incoming_dir: self.cfg.music_root.join(stage::INCOMING_DIR_NAME),
    };
    match tx.try_send(task) {
        Ok(()) => { self.board.transition(&job.job_id, JobState::Enqueued { queue_position: None }); }
        Err(_) => { /* fila do worker cheia: fica Queued, o próximo tick tenta de novo */ }
    }
    self.mark_dirty();
}

/// Aplica no board o que o worker devolveu. Chamado a cada tick do loop.
fn drain_fetch_events(&self, now: Instant) {
    let Some(rx) = &self.fetch_rx else { return };
    for ev in rx.try_iter().collect::<Vec<_>>() {
        match ev {
            FetchEvent::Started { job_id } => { self.board.transition(&job_id, JobState::Downloading { pct: 0.0, bps: 0, eta_s: None }); }
            FetchEvent::Progress { job_id, pct, bps, eta_s } => { self.board.transition(&job_id, JobState::Downloading { pct, bps, eta_s }); }
            FetchEvent::Done { job_id, flac_path, format_in } => {
                if let Some(mut job) = self.board.get(&job_id) {
                    job.format_in = Some(format_in);
                    self.board.upsert(job.clone());
                    self.board.transition(&job_id, JobState::Processing);
                    self.stage_and_ingest(&job, flac_path);
                }
            }
            FetchEvent::Rejected { job_id, reason, .. } => { self.board.transition(&job_id, JobState::Rejected { reason }); }
            FetchEvent::Failed { job_id, reason, retryable } => { self.board.transition(&job_id, JobState::Failed { reason, retryable }); }
        }
        self.mark_dirty();
    }
    // vagas abertas por terminais: promover a fila externa
    for kind in ["sound_cloud", "bandcamp"] { self.promote_external(kind); }
    let _ = now;
}
```

`stage::INCOMING_DIR_NAME` passa a ser `pub(crate)`.

7. `run_loop`: chamar `self.drain_fetch_events(now)` logo depois de `poll_active_search_once`. `handle_task`: braço `DownloadExternal`. `poll_active_transfers_once`: o `for job_id in active_ids` só entra em `poll_one_transfer` quando `job.soulseek().is_some()`; `Processing`/`Indexing` continuam para todos. `fail_network_dependent_jobs`: filtro adicional `job.soulseek().is_some()`. `promote_queued` (Soulseek): filtrar `Queued` com `soulseek().is_some()` e usar `max_active_for("soulseek")`. `cancel_job`: o `find_transfer` só quando `soulseek()`; para origem externa, só a transição local (o worker checa `is_canceled(job_id)` antes de cada etapa: acrescentar `pub(crate) fn is_canceled(&self, id) -> bool` no board, consultado pelo worker via `Arc<JobBoard>` na Task 6).

8. `enqueue_job`, `poll_one_transfer`, `begin_locate`, `handle_try_other_source`, `check_*_stall`, `handle_missing_transfer`, `handle_transfer_failure`: trocar `job.username`/`job.remote_filename`/`job.size` por `let Some((user, file, size)) = job.soulseek() else { return };`. Nos lugares em que a fonte troca (`try_other_source`), montar `Source::Soulseek` novo.

9. `spawn_coordinator`: receber `fetch: Option<(Sender<FetchTask>, Receiver<FetchEvent>)>` e encadear `with_fetch_channels`. Atualizar os 14 `DownloadJob {` dos testes com um helper `fn mk_job(...)` que preenche `source: Source::Soulseek{...}`, `meta: Default::default()`, `format_in: None`, `tracks: 1`.

- [ ] **Step 4: Rodar todos os testes do app**

Run: `cargo test -p rustify-player --lib slsk 2>&1 | tail -30`
Expected: todos os testes antigos e os novos passam.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/slsk/board.rs src-tauri/src/slsk/coordinator.rs src-tauri/src/slsk/stage.rs
git commit -m "feat(crate): coordinator roteia por origem, tarefa DownloadExternal e canal de eventos do worker"
```

**Ajustes pós-review (commit `fix(crate): ...` das Tasks 1 e 2) — valem sobre o texto acima e sobre as Tasks 6 e 7:**

- `DownloadJob.attempt: u32` (persistido): toda criação ou recriação de job ganha uma tentativa nova, de um contador monotônico do coordinator. `FetchTask.attempt` carrega o valor e **todo** `FetchEvent` o devolve (`Started { job_id, attempt }`, `Progress { job_id, attempt, .. }`, `Done { job_id, attempt, .. }`, `Rejected { job_id, attempt, .. }`, `Failed { job_id, attempt, .. }`). `drain_fetch_events` descarta evento de outra tentativa (e apaga o arquivo que ele trazia).
- `JobBoard::is_canceled(job_id, attempt)`: `true` se o job foi cancelado, recriado ou saiu do board.
- O worker grava `<task.file_stem()>.<ext>` e `<task.file_stem()>.flac` no incoming (`file_stem() = "<job_id>.a<attempt>"`), nunca `<job_id>.<ext>`: duas tentativas não dividem arquivo.
- `FetchEvent::Rejected { quarantine: Some(path) }` = arquivo que o coordinator move para `.rustify-quarentena`; `None` = nada a guardar.
- Um worker por origem: `Coordinator::with_fetch_worker(kind, tx)` + `with_fetch_events(rx)`; `spawn_coordinator(..., fetch: Option<FetchWiring>)` com `FetchWiring { workers: vec![("sound_cloud", ftx)], events: erx }`. Origem sem worker vira `Failed{"fonte ainda não suportada"}`; `DownloadExternal` com origem Soulseek é recusado.
- `poll_active_transfers_once` só consulta o slskd com job Soulseek em `Queued`/`Enqueued`/`Downloading`/`Stalled`.
- Job em `Indexing` persiste `indexing_path`; o boot retoma o ingest em vez de baixar de novo.
- Identidade das origens externas com prefixo `\u{0}` (`\u{0}sound_cloud\u{1}{track_id}`, `\u{0}bandcamp\u{1}...`); a do Soulseek segue sem prefixo, por compatibilidade com o `slsk_jobs.json`.
- `Waiting` persiste `waiting_since_unix`, lido da âncora que o `JobBoard` guarda na entrada em `Waiting` (`waiting_since_unix(id)`); `since_secs` é recalculado em toda leitura (`snapshot`/`get`) e o boot restaura a âncora com `upsert_at(job, now_unix)`. Nunca derivar o instante de entrada do `since_secs` gravado. Na fase 2 o boot (ou um tick) precisa reentregar ao worker os jobs em `Waiting`.
- `PersistedJob` persiste `format_in`; job externo restaurado em `Indexing` mantém o rótulo de formato.
- `Done` com `flac_path` fora do incoming vira `Failed { retryable: false }` sem tocar no arquivo. `Err` do `stage_file` em job externo apaga também `<incoming>/<job_id>.flac` (`stage::incoming_path`), não só o arquivo da tentativa.
- **Task 6:** `Stalled` não se aplica a origem externa; o worker é o responsável por não travar. Todo `ureq` com timeout (já previsto, 15 s) e o ffmpeg com teto de tempo (processo morto ao estourar); estouro vira `FetchEvent::Failed { retryable: true }`. Sem isso um worker preso ocupa uma das 2 vagas do SoundCloud indefinidamente.
- Falha antes de mover em job externo (Qdrant fora no dedup, `Err` do `stage_file`) apaga o arquivo do worker no incoming. `discard_fetched` e a quarentena do `Rejected` recusam caminho com componente que não seja nome comum (`..`).
- **Task 6:** o `artwork_url` que entra em `DownloadExternal`/`DownloadJob` entra já persistido no `PersistedJob` (o boot redespacha o job com a capa). E a Task 6 acrescenta o teste de latência da spec §8: worker falso emitindo `Progress` em rajada e um `Done`, com um `ClearFinished`/`DownloadExternal` enviado no meio respondendo em menos de 2 s (o `stage_and_ingest` roda síncrono na `slsk-coord`). Feito em `comandos_respondem_em_menos_de_2s_durante_download_externo` (coordinator.rs): o corpo do `run_loop` virou `Coordinator::tick(cmd_rx, emit)`, rodado numa thread no teste; ingest falso de 500 ms, dois `Done` (teto do SoundCloud) no meio de 4 000 `Progress`; o `ClearFinished` enviado com o ingest em curso respondeu em ~1,0 s. O ingest segue na `slsk-coord`, como a spec §2.4/§2.5 manda. Risco residual, igual ao do Soulseek: `IndexerHandle::ingest_paths` espera até 30 s pelo thread do indexer, e um scan em curso lá seguraria os comandos do Crate pelo mesmo tempo.
- **Nenhum `release.sh` desta branch antes da Task 7.** O contrato IPC do `slsk-jobs` já mudou (`username`/`remote_filename`/`size` saíram do topo do job; entraram `source`, `meta`, `format_in`, `tracks`, `attempt`) e o `Crate.tsx` ainda lê os campos antigos: a fila sairia com subtítulo vazio e "NaN MB". A branch recebe commits fora do Crate (ex.: curador Tidal), então a restrição vale para qualquer release, não só o do Crate.

---

### Task 3: Crate `soundcloud-client` (puro)

**Files:**
- Create: `src-tauri/crates/soundcloud-client/Cargo.toml`
- Create: `src-tauri/crates/soundcloud-client/src/lib.rs`
- Create: `src-tauri/crates/soundcloud-client/src/wire.rs`
- Create: `src-tauri/crates/soundcloud-client/src/client_id.rs`
- Create: `src-tauri/crates/soundcloud-client/src/http.rs`
- Create: `src-tauri/crates/soundcloud-client/tests/fixtures/{search_mandelao.json,track_native.json,track_gate.json,track_none.json,home.html,app_bundle.js}`
- Modify: `src-tauri/Cargo.toml` (members)

**Interfaces:**
- Produces:
  ```rust
  pub struct ScTrack { pub id: u64, pub title: String, pub permalink_url: String, pub user_name: String, pub user_permalink: String, pub duration_ms: u64, pub playback_count: u64, pub created_at: String, pub release_date: Option<String>, pub genre: Option<String>, pub artwork_url: Option<String>, pub downloadable: bool, pub has_downloads_left: bool, pub purchase_url: Option<String> }
  #[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "snake_case", tag = "kind")]
  pub enum Availability { Native, QuotaExhausted, ExternalGate { url: String }, None }
  pub fn availability(t: &ScTrack) -> Availability;
  pub fn parse_search(body: &str) -> Result<Vec<ScTrack>, ScError>;
  pub fn parse_track(body: &str) -> Result<ScTrack, ScError>;
  pub fn extract_client_id(bundle_js: &str) -> Option<String>;
  pub fn bundle_urls(home_html: &str) -> Vec<String>;
  pub fn bitrate_estimate_kbps(size_bytes: u64, duration_ms: u64) -> u32;
  pub fn ext_from_url(url: &str) -> Option<String>;
  pub struct Original { pub url: String, pub ext: String, pub size: Option<u64>, pub kbps_est: Option<u32> }
  pub enum ScError { NoToken, RateLimited, Http(u16), Transport(String), Parse(String) }
  pub trait SoundCloudApi: Send + Sync {
      fn search(&self, q: &str, limit: u32) -> Result<Vec<ScTrack>, ScError>;
      fn resolve(&self, url: &str) -> Result<ScTrack, ScError>;
      fn probe_original(&self, track_id: u64, token: &str) -> Result<Original, ScError>;
      fn download(&self, url: &str, dest: &std::path::Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), ScError>;
      fn fetch_bytes(&self, url: &str, max: usize) -> Result<Vec<u8>, ScError>;
      fn me(&self, token: &str) -> Result<(), ScError>;
  }
  pub struct HttpSoundCloud { .. } impl HttpSoundCloud { pub fn new(cache_path: PathBuf, user_agent: String) -> Self; }
  ```

- [ ] **Step 1: Capturar fixtures reais (uma vez, na cmr-auto)**

O `client_id` está em `~/.cache/yt-dlp/soundcloud/client_id.json` na cmr-auto (o yt-dlp o cacheia). Rodar:

```bash
ssh cmr-auto@100.102.249.9 'CID=$(python3 -c "import json;print(json.load(open(\"/home/cmr-auto/.cache/yt-dlp/soundcloud/client_id.json\"))[\"client_id\"])"); \
  curl -s "https://api-v2.soundcloud.com/search/tracks?q=mandel%C3%A3o&limit=10&client_id=$CID" > /tmp/search_mandelao.json; \
  curl -s "https://api-v2.soundcloud.com/tracks/2295944744?client_id=$CID" > /tmp/track_native.json; \
  curl -s "https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/djjohnsaucer/you-will-bolha-dj-john-1&client_id=$CID" > /tmp/track_gate.json; \
  curl -s "https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/djpiuoficial/mc-gw-e-dj-piu-bumbum-na-nuca-2020&client_id=$CID" > /tmp/track_none_or_native.json; \
  curl -sL "https://soundcloud.com/" > /tmp/home.html; \
  JS=$(grep -oE "https://a-v2\.sndcdn\.com/assets/[0-9a-z-]+\.js" /tmp/home.html | tail -1); curl -s "$JS" > /tmp/app_bundle.js; \
  grep -oE "client_id:\"[A-Za-z0-9]{32}\"" /tmp/app_bundle.js | head -1'
scp 'cmr-auto@100.102.249.9:/tmp/{search_mandelao.json,track_native.json,track_gate.json,track_none_or_native.json,home.html,app_bundle.js}' src-tauri/crates/soundcloud-client/tests/fixtures/
```

Se o último `grep` não imprimir nada, pegar outro bundle da lista (`grep -oE ... | sort -u`) até achar o `client_id`. Guardar só o bundle que contém (cortar com `grep -o ".\{200\}client_id:\"[A-Za-z0-9]\{32\}\".\{50\}"` para manter a fixture pequena, ~300 bytes, já que o teste só precisa do trecho). Se a faixa do DJ Piu vier `downloadable:false`, renomear para `track_none.json`; senão, achar outra sem download (qualquer faixa de perfil grande, ex. `https://soundcloud.com/anitta/...`) e salvar como `track_none.json`.

- [ ] **Step 2: Escrever os testes que falham**

`src-tauri/crates/soundcloud-client/src/lib.rs` (testes no fim do arquivo):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn fx(name: &str) -> String { std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap() }

    #[test]
    fn parse_search_devolve_faixas_com_campos_essenciais() {
        let tracks = parse_search(&fx("search_mandelao.json")).unwrap();
        assert!(!tracks.is_empty());
        let t = &tracks[0];
        assert!(t.id > 0 && !t.title.is_empty() && t.permalink_url.starts_with("https://soundcloud.com/"));
        assert!(t.duration_ms > 0);
    }

    #[test]
    fn availability_distingue_os_quatro_casos() {
        let native = parse_track(&fx("track_native.json")).unwrap();
        assert_eq!(availability(&native), Availability::Native);
        let gate = parse_track(&fx("track_gate.json")).unwrap();
        assert!(matches!(availability(&gate), Availability::ExternalGate { .. }));
        let none = parse_track(&fx("track_none.json")).unwrap();
        assert_eq!(availability(&none), Availability::None);
        let mut quota = native.clone();
        quota.has_downloads_left = false;
        assert_eq!(availability(&quota), Availability::QuotaExhausted);
    }

    #[test]
    fn client_id_sai_do_bundle_e_bundles_saem_da_home() {
        let urls = bundle_urls(&fx("home.html"));
        assert!(urls.iter().all(|u| u.starts_with("https://a-v2.sndcdn.com/assets/") && u.ends_with(".js")));
        assert!(!urls.is_empty());
        let id = extract_client_id(&fx("app_bundle.js")).expect("client_id no bundle");
        assert_eq!(id.len(), 32);
    }

    #[test]
    fn estimativa_de_bitrate_e_extensao() {
        assert_eq!(bitrate_estimate_kbps(7_267 * 1024, 183_000), 325);   // MP3 320 real do piloto
        assert_eq!(bitrate_estimate_kbps(3_586 * 1024, 228_000), 129);   // MP3 128 real do piloto
        assert_eq!(ext_from_url("https://cf-media.sndcdn.com/abc.wav?Policy=x&Signature=y").as_deref(), Some("wav"));
        assert_eq!(ext_from_url("https://x/y/track.MP3").as_deref(), Some("mp3"));
        assert_eq!(ext_from_url("https://x/y/noext"), None);
    }

    #[test]
    fn artwork_500() {
        assert_eq!(artwork_500("https://i1.sndcdn.com/artworks-abc-large.jpg"), "https://i1.sndcdn.com/artworks-abc-t500x500.jpg");
    }
}
```

- [ ] **Step 3: Rodar para ver falhar**

Run: `cargo test -p soundcloud-client`
Expected: erro, crate não existe.

- [ ] **Step 4: Implementar**

`Cargo.toml` do crate:

```toml
[package]
name = "soundcloud-client"
version = "0.1.0"
description = "Cliente puro da API v2 do SoundCloud: busca, resolve, sondagem e download do original. Sem Tauri."
edition.workspace = true
rust-version.workspace = true
authors.workspace = true
license.workspace = true

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
ureq = { workspace = true }
```

Acrescentar `"crates/soundcloud-client"` em `members` do workspace.

`wire.rs`: structs `#[derive(Deserialize)]` para o JSON (`collection: Vec<RawTrack>` na busca; `RawTrack { id, title, permalink_url, user: RawUser { username, permalink }, duration, full_duration, playback_count, created_at, release_date, genre, artwork_url, downloadable, has_downloads_left, purchase_url }`, tudo `Option` exceto `id`/`title`/`permalink_url`), e a conversão para `ScTrack` (`duration_ms = full_duration.or(duration).unwrap_or(0)`).

`lib.rs`:

```rust
pub fn availability(t: &ScTrack) -> Availability {
    if t.downloadable {
        if t.has_downloads_left { Availability::Native } else { Availability::QuotaExhausted }
    } else if let Some(u) = t.purchase_url.as_deref().filter(|u| !u.is_empty()) {
        Availability::ExternalGate { url: u.to_string() }
    } else {
        Availability::None
    }
}

pub fn bitrate_estimate_kbps(size_bytes: u64, duration_ms: u64) -> u32 {
    if duration_ms == 0 { return 0; }
    ((size_bytes as f64 * 8.0) / (duration_ms as f64)).round() as u32
}

pub fn ext_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let (_, ext) = name.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 { return None; }
    Some(ext.to_ascii_lowercase())
}

pub fn artwork_500(url: &str) -> String { url.replace("-large.", "-t500x500.") }
```

`client_id.rs`: `bundle_urls` (regex manual por `https://a-v2.sndcdn.com/assets/` até `.js`, sem crate de regex: iterar `match_indices`), `extract_client_id` (procurar `client_id:"` e ler 32 caracteres alfanuméricos), cache em JSON `{client_id, fetched_at}` no `cache_path`.

`http.rs`: `HttpSoundCloud` com `ureq::Agent` (timeouts 15 s), `client_id()` que lê o cache ou extrai (home → bundles do último para o primeiro → primeiro que tiver `client_id`), e os métodos do trait:

- `search`: `GET https://api-v2.soundcloud.com/search/tracks?q=<urlenc>&limit=<n>&client_id=<id>`; em 401/403 invalida o cache e tenta uma vez mais; 429 → `RateLimited`.
- `resolve`: `GET https://api-v2.soundcloud.com/resolve?url=<urlenc>&client_id=<id>`.
- `probe_original`: `GET https://api-v2.soundcloud.com/tracks/{id}/download?client_id=<id>` com header `Authorization: OAuth <token>`; 401 → `NoToken`; corpo `{"redirectUri": "..."}`; depois `HEAD` na URL (sem auth) para `Content-Length`; `ext_from_url`; `kbps_est` calculado pelo chamador que tem a duração (o método recebe `duration_ms: u64` como parâmetro extra: ajustar a assinatura do trait para `probe_original(&self, track_id, token, duration_ms)`).
- `download`: `GET` da URL em streaming, buffer de 256 KiB, chamando `progress(bytes_so_far, total)`; grava em `dest` via arquivo temporário `dest.part` e `rename` no fim.
- `fetch_bytes`: para a capa (limite `max`).
- `me`: `GET https://api-v2.soundcloud.com/me?client_id=` com o header OAuth; 401 → `NoToken`.

`urlenc` igual ao de `lyrics_fetch.rs` (copiar as 12 linhas; crates não compartilham).

- [ ] **Step 5: Rodar os testes**

Run: `cargo test -p soundcloud-client`
Expected: 5 testes passam. Teste manual opcional de rede, fora do CI: `cargo run -p soundcloud-client --example probe -- mandelão` (criar `examples/probe.rs` que imprime a busca; útil para o executor ver a API viva).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/crates/soundcloud-client
git commit -m "feat(soundcloud-client): cliente puro da API v2 com fixtures reais"
```

---

### Task 4: Conversão, sondagem de mídia, tags e capa no `library-indexer`

**Files:**
- Create: `src-tauri/crates/library-indexer/src/transcode.rs`
- Create: `src-tauri/crates/library-indexer/src/tagwrite.rs`
- Modify: `src-tauri/crates/library-indexer/src/cover.rs` (acrescentar `resize_cover_jpeg`)
- Modify: `src-tauri/crates/library-indexer/src/lib.rs` (exportar `transcode`, `tagwrite`, `resize_cover_jpeg`)
- Modify: `src-tauri/crates/library-indexer/Cargo.toml` (`lofty = "0.25"`)
- Test: nos próprios arquivos

**Interfaces:**
- Produces:
  ```rust
  // transcode.rs
  pub struct MediaProbe { pub codec: String, pub duration_s: f64, pub bit_rate_kbps: Option<u32>, pub bits_per_sample: Option<u16> }
  pub fn ffmpeg_available() -> bool;
  pub fn probe_media(path: &Path) -> Result<MediaProbe, String>;      // ffprobe -of json
  pub fn to_flac(src: &Path, dst: &Path) -> Result<(), String>;        // ffmpeg; valida saída
  // tagwrite.rs
  pub struct TagSet<'a> { pub artist: &'a str, pub album_artist: &'a str, pub album: &'a str, pub title: &'a str, pub year: Option<u32>, pub track_no: u32, pub track_total: u32, pub genre: &'a str, pub label: Option<&'a str>, pub comment: Option<&'a str> }
  pub fn write_tags(path: &Path, tags: &TagSet<'_>, cover_jpeg: Option<&[u8]>) -> Result<(), String>;
  // cover.rs
  pub fn resize_cover_jpeg(bytes: &[u8], max_side: u32) -> Result<Vec<u8>, String>;
  ```

- [ ] **Step 1: Escrever os testes que falham**

`transcode.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn have_ffmpeg() -> bool { ffmpeg_available() }

    fn synth(dir: &std::path::Path, name: &str, extra: &[&str]) -> std::path::PathBuf {
        let out = dir.join(name);
        let st = Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2"]).args(extra).arg(&out).status().unwrap();
        assert!(st.success());
        out
    }

    #[test]
    fn probe_media_mp3_128_vs_320_e_wav24() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let m320 = synth(tmp.path(), "a320.mp3", &["-b:a", "320k"]);
        let m128 = synth(tmp.path(), "a128.mp3", &["-b:a", "128k"]);
        let w24 = synth(tmp.path(), "a24.wav", &["-c:a", "pcm_s24le"]);
        let p = probe_media(&m320).unwrap();
        assert_eq!(p.codec, "mp3"); assert!(p.bit_rate_kbps.unwrap() >= 300, "{p:?}");
        let p = probe_media(&m128).unwrap();
        assert!(p.bit_rate_kbps.unwrap() < 200, "{p:?}");
        let p = probe_media(&w24).unwrap();
        assert_eq!(p.codec, "pcm_s24le"); assert_eq!(p.bits_per_sample, Some(24)); assert!((p.duration_s - 2.0).abs() < 0.1);
    }

    #[test]
    fn to_flac_converte_wav_e_preserva_duracao() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let w = synth(tmp.path(), "in.wav", &["-c:a", "pcm_s16le"]);
        let out = tmp.path().join("out.flac");
        to_flac(&w, &out).unwrap();
        let md = crate::parse_flac(&out).unwrap();
        assert!((md.duration_ms as f64 / 1000.0 - 2.0).abs() < 0.1);
        assert_eq!(md.bit_depth, 16);
    }

    #[test]
    fn to_flac_rejeita_saida_vazia_ou_invalida() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let bogus = tmp.path().join("lixo.wav");
        std::fs::write(&bogus, b"isto nao e audio").unwrap();
        let out = tmp.path().join("out.flac");
        let err = to_flac(&bogus, &out).unwrap_err();
        assert!(err.contains("ffmpeg"), "{err}");
        assert!(!out.exists(), "saída inválida não pode ficar no disco");
    }
}
```

`tagwrite.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn write_tags_reescreve_tudo_e_embute_capa() {
        if !crate::transcode::ffmpeg_available() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let flac = tmp.path().join("t.flac");
        let st = std::process::Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-metadata", "artist=www.ripper.com", "-metadata", "title=LIXO", "-c:a", "flac"]).arg(&flac).status().unwrap();
        assert!(st.success());
        let cover = crate::resize_cover_jpeg(&solid_png(64, 64), 1500).unwrap();
        let tags = TagSet { artist: "DJ Arana", album_artist: "DJ Arana", album: "Festa do Pente Rala", title: "Festa do Pente Rala", year: Some(2024), track_no: 1, track_total: 1, genre: "Funk Brasileiro", label: None, comment: Some("source: lossy mp3") };
        write_tags(&flac, &tags, Some(&cover)).unwrap();
        let md = crate::parse_flac(&flac).unwrap();
        assert_eq!(md.artist.as_deref(), Some("DJ Arana"));
        assert_eq!(md.album_artist.as_deref(), Some("DJ Arana"));
        assert_eq!(md.title.as_deref(), Some("Festa do Pente Rala"));
        assert_eq!(md.year, Some(2024));
        assert_eq!(md.track_number, Some(1));
        assert_eq!(md.genre_raw.as_deref(), Some("Funk Brasileiro"));
        assert_eq!(md.pictures.len(), 1);
        assert_eq!(md.pictures[0].mime, "image/jpeg");
    }

    fn solid_png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([30, 60, 140]));
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }
}
```

`cover.rs` (teste novo):

```rust
#[test]
fn resize_cover_jpeg_reduz_ate_o_lado_maximo() {
    let img = image::RgbImage::from_pixel(3000, 2000, image::Rgb([200, 10, 10]));
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
    let out = resize_cover_jpeg(&buf.into_inner(), 1500).unwrap();
    let back = image::load_from_memory(&out).unwrap();
    assert_eq!(back.width(), 1500); assert_eq!(back.height(), 1000);
    assert!(image::guess_format(&out).unwrap() == image::ImageFormat::Jpeg);
}
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `cargo test -p library-indexer transcode tagwrite resize_cover`
Expected: erro, módulos não existem.

- [ ] **Step 3: Implementar**

`transcode.rs`:

```rust
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone)]
pub struct MediaProbe { pub codec: String, pub duration_s: f64, pub bit_rate_kbps: Option<u32>, pub bits_per_sample: Option<u16> }

pub fn ffmpeg_available() -> bool {
    Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
        && Command::new("ffprobe").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
}

/// `ffprobe -of json`: codec do primeiro stream de áudio, duração e bitrate do container.
pub fn probe_media(path: &Path) -> Result<MediaProbe, String> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,bits_per_sample,bits_per_raw_sample:format=duration,bit_rate", "-of", "json"])
        .arg(path).output().map_err(|e| format!("ffprobe nao executou: {e}"))?;
    if !out.status.success() { return Err("ffprobe falhou: arquivo nao e audio reconhecido".into()); }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe json: {e}"))?;
    let s = v["streams"].get(0).ok_or("ffprobe: sem stream de audio")?;
    let codec = s["codec_name"].as_str().unwrap_or("").to_string();
    let bits = ["bits_per_raw_sample", "bits_per_sample"].iter()
        .filter_map(|k| s[k].as_str().and_then(|x| x.parse::<u16>().ok()).or_else(|| s[k].as_u64().map(|x| x as u16)))
        .find(|b| *b > 0);
    let bits = bits.or_else(|| match codec.as_str() { "pcm_s24le" | "pcm_s24be" => Some(24), "pcm_s16le" | "pcm_s16be" => Some(16), "pcm_s32le" => Some(32), _ => None });
    let duration_s = v["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let bit_rate_kbps = v["format"]["bit_rate"].as_str().and_then(|b| b.parse::<u64>().ok()).map(|b| (b / 1000) as u32);
    Ok(MediaProbe { codec, duration_s, bit_rate_kbps, bits_per_sample: bits })
}

/// WAV/AIFF/MP3 -> FLAC. Metadados e capa da origem descartados (serão reescritos).
/// Valida a saída: `parse_flac` + duração dentro de 2% (o ffmpeg pode sair 0 e escrever lixo).
pub fn to_flac(src: &Path, dst: &Path) -> Result<(), String> {
    let probe = probe_media(src).map_err(|e| format!("ffmpeg: origem invalida ({e})"))?;
    let tmp = dst.with_extension("flac.part");
    let st = Command::new("ffmpeg")
        .args(["-nostdin", "-loglevel", "error", "-y", "-i"]).arg(src)
        .args(["-vn", "-map_metadata", "-1", "-c:a", "flac", "-compression_level", "8"]).arg(&tmp)
        .status().map_err(|e| format!("ffmpeg nao executou: {e}"))?;
    if !st.success() { let _ = std::fs::remove_file(&tmp); return Err("ffmpeg falhou na conversao".into()); }
    let md = crate::parse_flac(&tmp).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("ffmpeg produziu FLAC invalido: {e}") })?;
    let got = md.duration_ms as f64 / 1000.0;
    if probe.duration_s > 0.0 && (got - probe.duration_s).abs() > probe.duration_s * 0.02 + 0.2 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("ffmpeg: duracao divergente ({got:.1}s vs {:.1}s)", probe.duration_s));
    }
    std::fs::rename(&tmp, dst).map_err(|e| format!("rename: {e}"))
}
```

`tagwrite.rs` (API do `lofty` 0.25; conferir nomes com `cargo doc -p lofty --open` se algo divergir):

```rust
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag, TagType};
use std::path::Path;

pub struct TagSet<'a> { /* como na interface */ }

pub fn write_tags(path: &Path, t: &TagSet<'_>, cover_jpeg: Option<&[u8]>) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| format!("lofty read: {e}"))?;
    // apaga tudo que veio do upload (artista = URL do ripper etc.)
    for tt in [TagType::VorbisComments, TagType::Id3v2, TagType::Id3v1, TagType::Ape] { tagged.remove(tt); }
    let mut tag = Tag::new(TagType::VorbisComments);
    tag.set_artist(t.artist.to_string());
    tag.insert_text(ItemKey::AlbumArtist, t.album_artist.to_string());
    tag.set_album(t.album.to_string());
    tag.set_title(t.title.to_string());
    if let Some(y) = t.year { tag.set_year(y); }
    tag.set_track(t.track_no);
    tag.set_track_total(t.track_total);
    tag.set_genre(t.genre.to_string());
    if let Some(l) = t.label { tag.insert_text(ItemKey::Label, l.to_string()); tag.insert_text(ItemKey::Publisher, l.to_string()); }
    if let Some(c) = t.comment { tag.set_comment(c.to_string()); }
    if let Some(bytes) = cover_jpeg {
        tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(MimeType::Jpeg), None, bytes.to_vec()));
    }
    tagged.insert_tag(tag);
    tagged.save_to_path(path, WriteOptions::default()).map_err(|e| format!("lofty save: {e}"))
}
```

`cover.rs`:

```rust
pub fn resize_cover_jpeg(bytes: &[u8], max_side: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("capa invalida: {e}"))?;
    let img = if img.width().max(img.height()) > max_side { img.resize(max_side, max_side, image::imageops::FilterType::Lanczos3) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
    enc.encode_image(&img.to_rgb8()).map_err(|e| format!("jpeg: {e}"))?;
    Ok(out.into_inner())
}
```

`lib.rs`: `pub mod transcode; pub mod tagwrite; pub use cover::resize_cover_jpeg;`. `Cargo.toml`: `lofty = "0.25"` em `[dependencies]` (versão exata: `cargo search lofty` deu 0.25.4 em 12/10/2026).

- [ ] **Step 4: Rodar os testes**

Run: `cargo test -p library-indexer transcode tagwrite resize_cover`
Expected: 5 testes passam (na VM há ffmpeg; se não houver, os de ffmpeg imprimem "pulado").

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.lock src-tauri/crates/library-indexer
git commit -m "feat(library-indexer): conversao para FLAC via ffmpeg, tags com lofty e capa JPEG 1500px"
```

---

### Task 5: Config das fontes, status, e nomes seguros para o Android

**Files:**
- Create: `src-tauri/src/slsk/sources.rs`
- Modify: `src-tauri/crates/slskd-client/src/stage_plan.rs` (`sanitize_component`)
- Modify: `src-tauri/src/slsk/mod.rs` (`mod sources;`)
- Test: nos próprios arquivos

**Interfaces:**
- Produces:
  ```rust
  #[derive(Clone)] pub struct SourcesConfig { pub sc_token_file: PathBuf, pub bc_identity_file: PathBuf, pub bc_email: String, pub ffmpeg: String, pub uv: String }
  impl SourcesConfig { pub fn load(data_dir: &Path) -> Self; pub fn read_sc_token(&self) -> Result<String, String>; }
  #[derive(Debug, Clone, Serialize)] #[serde(rename_all = "snake_case")]
  pub enum TokenStatus { TokenOk, NoToken, ApiDown }
  #[derive(Debug, Clone, Serialize)] #[serde(rename_all = "snake_case")]
  pub struct SourcesStatus { pub soundcloud: TokenStatus, pub ffmpeg: bool, pub uv: bool, pub bandcamp_identity: bool }
  pub fn read_secret_file(path: &Path) -> Result<String, String>;   // trim, erro claro, aviso se perm > 0600
  ```

- [ ] **Step 1: Escrever os testes que falham**

`sources.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn load_le_arquivo_e_env_sobrepoe() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("sources.json"), r#"{"soundcloud":{"oauth_token_file":"/a/sc.txt"},"bandcamp":{"identity_file":"/a/bc.txt","email":"x@y"},"tools":{"ffmpeg":"/opt/ffmpeg","uv":"/opt/uv"}}"#).unwrap();
        let cfg = SourcesConfig::load_with(tmp.path(), |k| if k == "RUSTIFY_FFMPEG" { Some("/usr/bin/ffmpeg".into()) } else { None });
        assert_eq!(cfg.sc_token_file, PathBuf::from("/a/sc.txt"));
        assert_eq!(cfg.bc_email, "x@y");
        assert_eq!(cfg.ffmpeg, "/usr/bin/ffmpeg");
        assert_eq!(cfg.uv, "/opt/uv");
    }
    #[test]
    fn defaults_expandem_til() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = SourcesConfig::load_with(tmp.path(), |_| None);
        assert!(cfg.sc_token_file.ends_with(".secrets/soundcloud-oauth.txt"));
        assert!(cfg.sc_token_file.is_absolute());
        assert!(tmp.path().join("sources.json").exists(), "arquivo criado com defaults na primeira execução");
    }
    #[test]
    fn read_secret_file_faz_trim_e_erro_claro() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("t.txt");
        std::fs::write(&f, "  2-abc-def  \n").unwrap();
        assert_eq!(read_secret_file(&f).unwrap(), "2-abc-def");
        let err = read_secret_file(&tmp.path().join("nao.txt")).unwrap_err();
        assert!(err.contains("nao.txt"));
        std::fs::write(&f, "\n").unwrap();
        assert!(read_secret_file(&f).is_err(), "arquivo vazio e erro, nao token vazio");
    }
}
```

`stage_plan.rs` (acrescentar ao módulo de testes existente):

```rust
#[test]
fn sanitize_component_android_safe() {
    assert_eq!(sanitize_component("Remix: vol. 2?"), "Remix_ vol. 2_");
    assert_eq!(sanitize_component("TABOO | TA13OO"), "TABOO _ TA13OO");
    assert_eq!(sanitize_component("AC/DC"), "AC DC");
    assert_eq!(sanitize_component("a\"b*c<d>e"), "a_b_c_d_e");
}
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `cargo test -p rustify-player --lib slsk::sources && cargo test -p slskd-client sanitize`
Expected: falha (módulo inexistente; `sanitize_component` mantém `:`).

- [ ] **Step 3: Implementar**

`stage_plan.rs`: no `map` de `sanitize_component`, `'/' | '\\' | '\0' => ' '` continua e acrescenta `':' | '"' | '*' | '?' | '<' | '>' | '|' => '_'`. Atualizar o doc-comment (o storage do Android recusa esses caracteres; `phone_sync_encode.py::safe_rel` faz o mesmo). Conferir os testes existentes de `stage_plan`/`stage` que esperem `:` preservado e ajustar a expectativa.

`sources.rs`: seguir o padrão de `config.rs` (`load_with(data_dir, env)`, `FileConfig` com `Option`s, defaults, `merge`, overrides `RUSTIFY_SC_TOKEN_FILE`, `RUSTIFY_BC_IDENTITY_FILE`, `RUSTIFY_BC_EMAIL`, `RUSTIFY_FFMPEG`, `RUSTIFY_UV`). Defaults: `~/.secrets/soundcloud-oauth.txt`, `~/.secrets/bandcamp-identity.txt`, `""`, `"ffmpeg"`, `~/.local/bin/uv`. Expansão de `~` por `HOME`. Na primeira execução sem arquivo, gravar `sources.json` com os defaults (tmp+rename). `Debug` manual sem conteúdo de segredo (só caminhos). `read_secret_file`: `read_to_string` → `trim` → vazio é `Err("arquivo de segredo vazio: <path>")`; no Unix, se `mode & 0o077 != 0`, `tracing::warn!` uma vez. `read_sc_token` = `read_secret_file(&self.sc_token_file)`.

`SourcesStatus` é montado em `mod.rs` na Task 7 (precisa do cliente SoundCloud para `me`); aqui só os tipos e `fn tools_status(cfg) -> (bool, bool)` que roda `<ffmpeg> -version` e `<uv> --version`.

- [ ] **Step 4: Rodar os testes**

Run: `cargo test -p rustify-player --lib slsk && cargo test -p slskd-client`
Expected: passam.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/slsk/sources.rs src-tauri/src/slsk/mod.rs src-tauri/crates/slskd-client/src/stage_plan.rs
git commit -m "feat(crate): config das fontes (sources.json + env), leitura de segredo e nomes seguros para o Android"
```

---

### Task 6: Worker do SoundCloud

**Files:**
- Create: `src-tauri/src/slsk/sc_worker.rs`
- Modify: `src-tauri/src/slsk/mod.rs` (`mod sc_worker;`)
- Test: em `sc_worker.rs`, com `FakeSc` implementando `SoundCloudApi`

**Interfaces:**
- Consumes: `FetchTask`, `FetchEvent` (Task 2); `SoundCloudApi`, `Original`, `ScError`, `artwork_500` (Task 3); `transcode::{probe_media, to_flac}`, `tagwrite::{write_tags, TagSet}`, `resize_cover_jpeg` (Task 4); `SourcesConfig::read_sc_token` (Task 5); `JobBoard::is_canceled` (Task 2).
- Produces:
  ```rust
  pub fn spawn_sc_worker(rx: Receiver<FetchTask>, tx: Sender<FetchEvent>, api: Arc<dyn SoundCloudApi>, cfg: Arc<SourcesConfig>, board: Arc<JobBoard>) -> JoinHandle<()>;
  /// Puro, testável: decide o FormatIn (ou a rejeição) a partir da sondagem do arquivo baixado.
  pub fn classify_original(ext: &str, probe: &MediaProbe) -> Result<FormatIn, RejectReason>;
  pub const MIN_MP3_KBPS: u32 = 300;
  ```

- [ ] **Step 1: Escrever os testes que falham**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn classify_original_cobre_a_tabela_da_spec() {
        let p = |codec: &str, kbps: Option<u32>, bits: Option<u16>| MediaProbe { codec: codec.into(), duration_s: 100.0, bit_rate_kbps: kbps, bits_per_sample: bits };
        assert_eq!(classify_original("wav", &p("pcm_s24le", None, Some(24))), Ok(FormatIn::Wav24));
        assert_eq!(classify_original("wav", &p("pcm_s16le", None, Some(16))), Ok(FormatIn::Wav16));
        assert_eq!(classify_original("aiff", &p("pcm_s16be", None, Some(16))), Ok(FormatIn::Aiff));
        assert_eq!(classify_original("flac", &p("flac", None, Some(16))), Ok(FormatIn::Flac));
        assert_eq!(classify_original("mp3", &p("mp3", Some(320), None)), Ok(FormatIn::Mp3_320));
        assert_eq!(classify_original("mp3", &p("mp3", Some(128), None)), Err(RejectReason::LowBitrate { kbps: 128 }));
        // extensão mente: ".wav" que é mp3 por dentro segue a sondagem
        assert_eq!(classify_original("wav", &p("mp3", Some(192), None)), Err(RejectReason::LowBitrate { kbps: 192 }));
        assert_eq!(classify_original("m4a", &p("aac", Some(256), None)), Err(RejectReason::NoDownload));
    }

    struct FakeSc { src: std::path::PathBuf, ext: &'static str, fail_401: bool, log: Mutex<Vec<String>> }
    impl SoundCloudApi for FakeSc {
        fn search(&self, _: &str, _: u32) -> Result<Vec<ScTrack>, ScError> { unimplemented!() }
        fn resolve(&self, _: &str) -> Result<ScTrack, ScError> { unimplemented!() }
        fn probe_original(&self, _: u64, _: &str, _: u64) -> Result<Original, ScError> {
            if self.fail_401 { return Err(ScError::NoToken); }
            Ok(Original { url: "fake://orig".into(), ext: self.ext.into(), size: Some(std::fs::metadata(&self.src).unwrap().len()), kbps_est: None })
        }
        fn download(&self, _: &str, dest: &std::path::Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), ScError> {
            std::fs::copy(&self.src, dest).unwrap(); progress(10, Some(10)); self.log.lock().unwrap().push("download".into()); Ok(())
        }
        fn fetch_bytes(&self, _: &str, _: usize) -> Result<Vec<u8>, ScError> { Err(ScError::Http(404)) }
        fn me(&self, _: &str) -> Result<(), ScError> { Ok(()) }
    }

    fn setup(ext: &'static str, extra: &[&str], fail_401: bool) -> (tempfile::TempDir, Arc<FakeSc>, Arc<SourcesConfig>, Arc<JobBoard>) {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join(format!("orig.{ext}"));
        let st = std::process::Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2"]).args(extra).arg(&src).status().unwrap();
        assert!(st.success());
        let token = tmp.path().join("tok.txt"); std::fs::write(&token, "2-x-y-z").unwrap();
        let mut cfg = SourcesConfig::load_with(tmp.path(), |_| None); cfg.sc_token_file = token;
        (tmp, Arc::new(FakeSc { src, ext, fail_401, log: Mutex::new(vec![]) }), Arc::new(cfg), Arc::new(JobBoard::new()))
    }

    fn task(tmp: &tempfile::TempDir) -> FetchTask {
        let incoming = tmp.path().join(".rustify-incoming"); std::fs::create_dir_all(&incoming).unwrap();
        FetchTask { job_id: "j1".into(), attempt: 0, source: Source::SoundCloud { track_id: 1, permalink_url: "https://soundcloud.com/a/b".into() },
            meta: ConfirmedMeta { artist: "DJ Arana".into(), title: "Festa".into(), album: "Festa".into(), year: Some(2024), label: None },
            playlist: "Funk Brasileiro".into(), incoming_dir: incoming }
    }

    fn run_one(api: Arc<FakeSc>, cfg: Arc<SourcesConfig>, board: Arc<JobBoard>, t: FetchTask) -> Vec<FetchEvent> {
        let (ftx, frx) = crossbeam_channel::bounded(1); let (etx, erx) = crossbeam_channel::unbounded();
        let h = spawn_sc_worker(frx, etx, api, cfg, board); ftx.send(t).unwrap(); drop(ftx); h.join().unwrap();
        erx.try_iter().collect()
    }

    #[test]
    fn wav_vira_flac_com_tags_e_done() {
        if !transcode::ffmpeg_available() { return; }
        let (tmp, api, cfg, board) = setup("wav", &["-c:a", "pcm_s24le"], false);
        let evs = run_one(api, cfg, board, task(&tmp));
        let done = evs.iter().find_map(|e| if let FetchEvent::Done { flac_path, format_in, .. } = e { Some((flac_path.clone(), *format_in)) } else { None }).expect("Done");
        assert_eq!(done.1, FormatIn::Wav24);
        let md = library_indexer::parse_flac(&done.0).unwrap();
        assert_eq!(md.artist.as_deref(), Some("DJ Arana")); assert_eq!(md.genre_raw.as_deref(), Some("Funk Brasileiro"));
        assert!(evs.iter().any(|e| matches!(e, FetchEvent::Progress { .. })));
    }

    #[test]
    fn mp3_abaixo_de_300_rejeita_low_bitrate() {
        if !transcode::ffmpeg_available() { return; }
        let (tmp, api, cfg, board) = setup("mp3", &["-b:a", "128k"], false);
        let evs = run_one(api, cfg, board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Rejected { reason: RejectReason::LowBitrate { .. }, .. })), "{evs:?}");
        assert!(!tmp.path().join(".rustify-incoming/j1.a0.mp3").exists(), "original rejeitado sai do incoming");
    }

    #[test]
    fn mp3_320_entra_com_comment_de_origem() {
        if !transcode::ffmpeg_available() { return; }
        let (tmp, api, cfg, board) = setup("mp3", &["-b:a", "320k"], false);
        let evs = run_one(api, cfg, board, task(&tmp));
        let (path, fmt) = evs.iter().find_map(|e| if let FetchEvent::Done { flac_path, format_in, .. } = e { Some((flac_path.clone(), *format_in)) } else { None }).unwrap();
        assert_eq!(fmt, FormatIn::Mp3_320);
        let md = library_indexer::parse_flac(&path).unwrap();
        assert!(md.tags.iter().any(|t| t.contains("lossy")) || true, "COMMENT nao e lido por parse_flac; conferir via lofty");
        let tagged = lofty::read_from_path(&path).unwrap();
        use lofty::prelude::*; let c = tagged.primary_tag().and_then(|t| t.comment().map(|s| s.to_string()));
        assert_eq!(c.as_deref(), Some("source: lossy mp3"));
    }

    #[test]
    fn fake_sc_download_401_falha_sem_retry() {
        if !transcode::ffmpeg_available() { return; }
        let (tmp, api, cfg, board) = setup("wav", &[], true);
        let evs = run_one(api, cfg, board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, reason, .. }) if reason.contains("token")), "{evs:?}");
    }

    #[test]
    fn sem_arquivo_de_token_falha_antes_de_baixar() {
        let (tmp, api, cfg, board) = setup("wav", &[], false);
        let mut cfg2 = (*cfg).clone(); cfg2.sc_token_file = tmp.path().join("inexistente.txt");
        let evs = run_one(api.clone(), Arc::new(cfg2), board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, .. })));
        assert!(api.log.lock().unwrap().is_empty(), "nao baixou nada");
    }
}
```

(`lofty` entra também como dependência do crate do app para o teste; alternativa: expor `read_comment(path)` em `tagwrite.rs` e usar aqui.)

- [ ] **Step 2: Rodar para ver falhar**

Run: `cargo test -p rustify-player --lib slsk::sc_worker`
Expected: erro, módulo inexistente.

- [ ] **Step 3: Implementar**

```rust
//! sc_worker.rs — thread `sc-worker`: executa o download de UMA faixa do
//! SoundCloud e entrega um FLAC pronto (tags + capa) ao coordinator. Nunca
//! toca no board a não ser para checar cancelamento. Spec §2.4 e §4.3.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use crossbeam_channel::{Receiver, Sender};
use library_indexer::transcode::{self, MediaProbe};
use library_indexer::tagwrite::{write_tags, TagSet};
use soundcloud_client::{artwork_500, ScError, SoundCloudApi};
use super::board::{ConfirmedMeta, FormatIn, JobBoard, RejectReason, Source};
use super::coordinator::{FetchEvent, FetchTask};
use super::sources::SourcesConfig;

pub const MIN_MP3_KBPS: u32 = 300;
const COVER_MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn classify_original(ext: &str, p: &MediaProbe) -> Result<FormatIn, RejectReason> {
    match p.codec.as_str() {
        "flac" => Ok(FormatIn::Flac),
        c if c.starts_with("pcm_") => {
            if ext == "aiff" || ext == "aif" { return Ok(FormatIn::Aiff); }
            Ok(if p.bits_per_sample.unwrap_or(16) >= 24 { FormatIn::Wav24 } else { FormatIn::Wav16 })
        }
        "mp3" => {
            let kbps = p.bit_rate_kbps.unwrap_or(0);
            if kbps >= MIN_MP3_KBPS { Ok(FormatIn::Mp3_320) } else { Err(RejectReason::LowBitrate { kbps }) }
        }
        _ => Err(RejectReason::NoDownload),
    }
}

pub fn spawn_sc_worker(rx: Receiver<FetchTask>, tx: Sender<FetchEvent>, api: Arc<dyn SoundCloudApi>, cfg: Arc<SourcesConfig>, board: Arc<JobBoard>) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new().name("sc-worker".into()).spawn(move || {
        for task in rx.iter() {
            let ev = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_task(&task, api.as_ref(), &cfg, &board, &tx)))
                .unwrap_or_else(|_| FetchEvent::Failed { job_id: task.job_id.clone(), attempt: task.attempt, reason: "panic no sc-worker".into(), retryable: false });
            let _ = tx.send(ev);
        }
    }).expect("spawn sc-worker")
}

fn run_task(t: &FetchTask, api: &dyn SoundCloudApi, cfg: &SourcesConfig, board: &JobBoard, tx: &Sender<FetchEvent>) -> FetchEvent {
    let job_id = t.job_id.clone();
    let attempt = t.attempt;
    let fail = |reason: String, retryable: bool| FetchEvent::Failed { job_id: job_id.clone(), attempt, reason, retryable };
    let Source::SoundCloud { track_id, .. } = &t.source else { return fail("worker do SoundCloud recebeu outra origem".into(), false) };
    let token = match cfg.read_sc_token() { Ok(tk) => tk, Err(e) => return fail(format!("sem token do SoundCloud: {e}"), false) };
    if board.is_canceled(&job_id, attempt) { return FetchEvent::Failed { job_id, attempt, reason: "cancelado".into(), retryable: false }; }
    // 1) sondagem do original
    let orig = match api.probe_original(*track_id, &token, 0) {
        Ok(o) => o,
        Err(ScError::NoToken) => return fail("token do SoundCloud recusado (expirado?)".into(), false),
        Err(ScError::RateLimited) => return fail("SoundCloud limitou as chamadas; tente em alguns minutos".into(), true),
        Err(e) => return fail(format!("SoundCloud: {e}"), true),
    };
    // 2) download para o incoming
    let raw = t.incoming_dir.join(format!("{}.{}", t.file_stem(), orig.ext));
    let _ = tx.send(FetchEvent::Started { job_id: job_id.clone(), attempt });
    let started = Instant::now();
    let mut last = Instant::now();
    let mut cb = |done: u64, total: Option<u64>| {
        if last.elapsed().as_millis() < 300 { return; }
        last = Instant::now();
        let secs = started.elapsed().as_secs_f64().max(0.001);
        let bps = (done as f64 / secs) as u64;
        let pct = total.map(|tt| if tt > 0 { done as f32 * 100.0 / tt as f32 } else { 0.0 }).unwrap_or(0.0);
        let eta = total.filter(|tt| bps > 0 && *tt > done).map(|tt| ((tt - done) / bps.max(1)) as u32);
        let _ = tx.send(FetchEvent::Progress { job_id: job_id.clone(), attempt, pct, bps, eta_s: eta });
    };
    if let Err(e) = api.download(&orig.url, &raw, &mut cb) {
        let _ = std::fs::remove_file(&raw);
        return match e { ScError::NoToken | ScError::Http(401) | ScError::Http(403) => fail("token do SoundCloud recusado no download".into(), false), e => fail(format!("download: {e}"), true) };
    }
    if board.is_canceled(&job_id, attempt) { let _ = std::fs::remove_file(&raw); return FetchEvent::Failed { job_id, attempt, reason: "cancelado".into(), retryable: false }; }
    // 3) sondagem real e classificação
    let probe = match transcode::probe_media(&raw) { Ok(p) => p, Err(e) => { let _ = std::fs::remove_file(&raw); return fail(format!("arquivo baixado nao e audio: {e}"), false); } };
    let format_in = match classify_original(&orig.ext, &probe) {
        Ok(f) => f,
        Err(reason) => { let _ = std::fs::remove_file(&raw); return FetchEvent::Rejected { job_id, attempt, reason, quarantine: None }; }
    };
    // 4) FLAC no incoming
    let flac = t.incoming_dir.join(format!("{}.flac", t.file_stem()));
    let conv = if format_in == FormatIn::Flac { std::fs::rename(&raw, &flac).map_err(|e| e.to_string()) } else { transcode::to_flac(&raw, &flac).map(|_| { let _ = std::fs::remove_file(&raw); }) };
    if let Err(e) = conv { let _ = std::fs::remove_file(&raw); let _ = std::fs::remove_file(&flac); return fail(e, false); }
    // 5) capa (melhor esforço) e tags
    let cover = t.meta_cover_url().and_then(|u| api.fetch_bytes(&artwork_500(&u), COVER_MAX_BYTES).ok()).and_then(|b| library_indexer::resize_cover_jpeg(&b, 1500).ok());
    let comment = if format_in.is_lossy() { Some("source: lossy mp3") } else { None };
    let tags = TagSet { artist: &t.meta.artist, album_artist: &t.meta.artist, album: &t.meta.album, title: &t.meta.title, year: t.meta.year, track_no: 1, track_total: 1, genre: &t.playlist, label: t.meta.label.as_deref(), comment };
    if let Err(e) = write_tags(&flac, &tags, cover.as_deref()) { let _ = std::fs::remove_file(&flac); return fail(format!("tags: {e}"), false); }
    FetchEvent::Done { job_id, attempt, flac_path: flac, format_in }
}
```

`FetchTask` ganha `artwork_url: Option<String>` (o coordinator o copia de `Source`/`meta`; acrescentar `pub artwork_url: Option<String>` em `ConfirmedMeta`? Não: manter o `ConfirmedMeta` limpo e colocar `artwork_url: Option<String>` em `FetchTask`, preenchido pelo comando `crate_download` que recebe `artwork_url` do frontend — ajustar a Task 2: `SlskTask::DownloadExternal` ganha `artwork_url: Option<String>` e `DownloadJob` guarda `artwork_url` para o reboot). Trocar `t.meta_cover_url()` por `t.artwork_url.clone()`.

`JobBoard::is_canceled(&self, id, attempt) -> bool` já existe em `board.rs` (Task 2, ajuste pós-review).

`stage_file` recebe o FLAC do incoming como `local`; ele move para `.rustify-incoming/<job_id>.flac` (mesmo caminho: `move_file` com `rename` para o mesmo path é um no-op em Linux; se a implementação falhar com "mesmo arquivo", tratar em `stage_file`: `if local == incoming_path { skip }`). A capa `cover.jpg` na pasta final: no coordinator, após `Staged { final_path }` de um job com `format_in.is_some()`, extrair a PICTURE do próprio FLAC (`parse_flac(final_path).pictures[0]`) e gravar `cover.jpg` ao lado se não existir (função `stage::write_folder_cover(final_path)`), com teste em `stage.rs`.

- [ ] **Step 4: Rodar os testes**

Run: `cargo test -p rustify-player --lib slsk::sc_worker`
Expected: 6 testes passam (os de ffmpeg pulam só se não houver ffmpeg).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/slsk/sc_worker.rs src-tauri/src/slsk/mod.rs src-tauri/src/slsk/board.rs src-tauri/src/slsk/coordinator.rs src-tauri/src/slsk/stage.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(crate): worker do SoundCloud (download, sondagem, conversao, tags, capa)"
```

---

### Task 7: Comandos Tauri e wiring

**Files:**
- Modify: `src-tauri/src/slsk/mod.rs` (`Slsk::new`, comandos novos)
- Modify: `src-tauri/src/desktop.rs:3499-3508` (registro)
- Modify: `src/tauri.ts` (tipos e wrappers)
- Test: `cargo test -p rustify-player --lib slsk` (status sem rede) + `npm run typecheck`

**Interfaces:**
- Produces (Rust, `#[tauri::command]`):
  ```rust
  crate_sc_search(sl, query: String) -> Result<Vec<ScResult>, String>        // async, roda em thread (tauri::async_runtime::spawn_blocking)
  crate_sc_resolve(sl, url: String) -> Result<ScResult, String>
  crate_sc_probe(sl, track_id: u64, duration_ms: u64) -> Result<ScProbe, String>   // formato/tamanho com o token
  crate_sc_artwork(sl, url: String) -> Result<String, String>                // data URL jpeg <= 500px
  crate_download(sl, source: Source, meta: ConfirmedMeta, dest_playlist: String, artwork_url: Option<String>) -> Result<String, String>
  crate_sources_status(sl) -> SourcesStatus
  #[derive(Serialize)] struct ScResult { id: u64, title: String, permalink_url: String, user_name: String, user_permalink: String, duration_ms: u64, playback_count: u64, created_at: String, release_date: Option<String>, genre: Option<String>, artwork_url: Option<String>, availability: Availability, suggested_dest: Option<String> }
  #[derive(Serialize)] struct ScProbe { ext: String, size: Option<u64>, kbps_est: Option<u32>, format_label: String, allowed: bool, reason: Option<String> }
  ```
- Produces (TS):
  ```ts
  export type Source = { kind: "soulseek"; username: string; remote_filename: string; size: number } | { kind: "sound_cloud"; track_id: number; permalink_url: string } | { kind: "bandcamp"; item_type: string; item_id: number; url: string };
  export interface ConfirmedMeta { artist: string; title: string; album: string; year: number | null; label: string | null }
  export type Availability = { kind: "native" } | { kind: "quota_exhausted" } | { kind: "external_gate"; url: string } | { kind: "none" };
  export interface ScResult {...}  export interface ScProbe {...}
  export type RejectReason = ... | { low_bitrate: { kbps: number } } | "no_download";
  export type JobState = ... | { kind: "waiting"; reason: "purchase" | "email_link"; url: string; since_secs: number };
  export interface DownloadJob { job_id; source: Source; meta: ConfirmedMeta; format_in: "flac"|"wav24"|"wav16"|"aiff"|"mp3_320"|null; tracks: number; display; dest_playlist; state; quality_label; alternates; tried_source_ids; created_at }
  export interface SourcesStatus { soundcloud: "token_ok" | "no_token" | "api_down"; ffmpeg: boolean; uv: boolean; bandcamp_identity: boolean }
  export const crateScSearch, crateScResolve, crateScProbe, crateScArtwork, crateDownload, crateSourcesStatus
  ```

- [ ] **Step 1: Escrever o teste que falha (status sem rede)**

Em `mod.rs`, módulo `tests`:

```rust
#[test]
fn sources_status_sem_token_e_sem_ffmpeg_inexistente() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = sources::SourcesConfig::load_with(tmp.path(), |_| None);
    cfg.sc_token_file = tmp.path().join("nao.txt");
    cfg.ffmpeg = "/caminho/inexistente/ffmpeg".into();
    let st = compute_sources_status(&cfg, None);   // None = sem cliente (não chama a rede)
    assert!(matches!(st.soundcloud, sources::TokenStatus::NoToken));
    assert!(!st.ffmpeg);
}
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `cargo test -p rustify-player --lib slsk::tests::sources_status`
Expected: `compute_sources_status` não existe.

- [ ] **Step 3: Implementar**

`Slsk` ganha `sc_api: Arc<dyn SoundCloudApi>`, `sources: Arc<SourcesConfig>`, `status_cache: Mutex<Option<(Instant, SourcesStatus)>>` (TTL 10 min para `me`), e `Slsk::new` cria `HttpSoundCloud::new(data_dir.join("soundcloud_client_id.json"), user_agent)`, os canais `bounded::<FetchTask>(16)` / `unbounded::<FetchEvent>()`, chama `sc_worker::spawn_sc_worker(frx.clone(), etx.clone(), sc_api.clone(), sources.clone(), board.clone())` `MAX_ACTIVE_SOUNDCLOUD` vezes (decisão do review da Task 6: o teto 2 da spec §2.4 é de downloads simultâneos; cada chamada sobe UMA thread e o canal do crossbeam é MPMC, então as duas instâncias dividem o mesmo `Receiver`; com uma só, o segundo job aceito ficaria parado em `Enqueued` até o primeiro terminar; teste `duas_instancias_baixam_em_paralelo`) e passa `Some(FetchWiring { workers: vec![("sound_cloud", ftx)], events: erx })` ao `spawn_coordinator`.

`compute_sources_status(cfg, sc: Option<(&dyn SoundCloudApi, &str)>)`: `ffmpeg`/`uv` por `tools_status`; `bandcamp_identity` = arquivo existe e não vazio; `soundcloud` = `NoToken` se `read_sc_token` falha; senão, com cliente, `me(token)` → `TokenOk`, `Err(NoToken)` → `NoToken`, outro erro → `ApiDown`; sem cliente, `TokenOk` se o arquivo existe (só nos testes).

Comandos: `crate_sc_search` e os demais que vão à rede são `async fn` e usam `tauri::async_runtime::spawn_blocking` com o `Arc` do cliente (nunca bloquear a thread do IPC). `suggested_dest` do `ScResult`: `OwnedIndex::folder_for_artist(user_name)` via o `IndexerHandle` (o `Slsk` guarda um clone do handle; se construir o `OwnedIndex` por busca for caro, usar o cache do coordinator: expor `Slsk::suggest_dest(artist) -> Option<String>` que chama `library_indexer::OwnedIndex::build` com cache de 60 s no `Slsk`). `crate_sc_artwork`: `fetch_bytes` + `resize_cover_jpeg(…, 500)` + `format!("data:image/jpeg;base64,{}", base64)` (sem crate novo: implementar `base64_encode` de 20 linhas em `sources.rs` ou usar `base64` já presente no lock, se houver). `crate_download`: valida `source` (fase 1 aceita só `SoundCloud`; `Bandcamp` devolve `Err("fonte ainda nao suportada")`) e manda `SlskTask::DownloadExternal`.

Registrar os seis comandos em `desktop.rs` no `generate_handler!`. Em `tauri.ts`, acrescentar os tipos/wrappers acima e atualizar `DownloadJob`/`JobState`/`RejectReason`. `src/components/Sidebar.test.tsx:85` e `src/store/crate.test.ts` que constroem `DownloadJob` com `username` passam a usar `source: { kind: "soulseek", username: "peer", remote_filename: "...", size: 0 }`, `meta: { artist: "", title: "", album: "", year: null, label: null }`, `format_in: null`, `tracks: 1`.

- [ ] **Step 4: Validar**

Run: `cargo test -p rustify-player --lib slsk && cargo check --manifest-path src-tauri/Cargo.toml && cd /home/opc/rustify-player && npm run typecheck && npm test -- --run src/store src/components/Sidebar.test.tsx`
Expected: tudo verde.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/slsk/mod.rs src-tauri/src/desktop.rs src/tauri.ts src/components/Sidebar.test.tsx src/store/crate.test.ts
git commit -m "feat(crate): comandos crate_sc_* e crate_download, status das fontes, tipos TS"
```

---

### Task 8: Sugestão de metadado (frontend, puro)

**Files:**
- Create: `src/lib/trackMetaGuess.ts`
- Create: `src/lib/trackMetaGuess.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ScLike { title: string; user_name: string; user_permalink: string; created_at: string; release_date: string | null }
  export interface MetaGuess { artist: string; title: string; album: string; year: number | null }
  export function guessFromSoundCloud(t: ScLike): MetaGuess;
  export function cleanTitle(raw: string): string;
  export function smartCase(s: string): string;
  export function looseEq(a: string, b: string): boolean;
  export function looksLikeUrl(s: string): boolean;
  ```

- [ ] **Step 1: Escrever os testes que falham**

```ts
import { describe, it, expect } from "vitest";
import { guessFromSoundCloud, cleanTitle, smartCase, looseEq, looksLikeUrl } from "./trackMetaGuess";

const base = { user_permalink: "x", created_at: "2024-12-26T10:00:00Z", release_date: null };

describe("trackMetaGuess", () => {
  it("separa 'TÍTULO - ARTISTA' quando a cauda bate com o perfil", () => {
    const g = guessFromSoundCloud({ ...base, title: "FESTA DO PENTE RALA - DJ ARANA.mp3", user_name: "DJ ARANA OFICIAL" });
    expect(g).toEqual({ artist: "DJ Arana", title: "Festa do Pente Rala", album: "Festa do Pente Rala", year: 2024 });
  });
  it("separa 'ARTISTA - TÍTULO' quando a cabeça bate com o perfil", () => {
    const g = guessFromSoundCloud({ ...base, title: "MC GW e DJ Piu - Bumbum na Nuca", user_name: "DJ PIU" });
    expect(g.artist).toBe("MC GW e DJ Piu");
    expect(g.title).toBe("Bumbum na Nuca");
  });
  it("sem separador usa o nome do perfil e limpa sufixos", () => {
    const g = guessFromSoundCloud({ ...base, title: "QUANDO A VONTADE BATER BRUXARIA (FREE DOWNLOAD)", user_name: "DJ NICOLAS BEAT" });
    expect(g.title).toBe("Quando a Vontade Bater Bruxaria");
    expect(g.artist).toBe("DJ Nicolas Beat");
  });
  it("perfil anônimo 'user-577945535' não vira artista", () => {
    const g = guessFromSoundCloud({ ...base, title: "UM CARA TRANQUILO", user_name: "user-577945535" });
    expect(g.artist).toBe("");
  });
  it("release_date vence created_at no ano", () => {
    const g = guessFromSoundCloud({ ...base, title: "Job", user_name: "Adame DJ", release_date: "2026-03-20T00:00:00Z" });
    expect(g.year).toBe(2026);
  });
  it("smartCase preserva siglas e tokens com dígitos", () => {
    expect(smartCase("MANDELÃO MC MR BIM 150BPM SP")).toBe("Mandelão MC Mr Bim 150BPM SP");
    expect(smartCase("Já em Title Case")).toBe("Já em Title Case");
  });
  it("cleanTitle tira (FREE DOWNLOAD), [FREE DL], .wav, WAV no fim e espaços", () => {
    expect(cleanTitle("X  [FREE DL] .wav")).toBe("X");
    expect(cleanTitle("BRUXARIA DO BECO DA MORTE wav")).toBe("BRUXARIA DO BECO DA MORTE");
  });
  it("looseEq e looksLikeUrl", () => {
    expect(looseEq("DJ ARANA", "Dj Arana Oficial")).toBe(true);
    expect(looseEq("Pe$te & Edge", "PE$TE e Edge")).toBe(true);
    expect(looseEq("DJ K", "DJ Arana")).toBe(false);
    expect(looksLikeUrl("www.ftpdjemilio.com")).toBe(true);
    expect(looksLikeUrl("DJ Anderson do Paraíso")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -- --run src/lib/trackMetaGuess.test.ts`
Expected: falha, módulo não existe.

- [ ] **Step 3: Implementar**

```ts
const KEEP_UPPER = new Set(["DJ", "MC", "MCS", "BPM", "SP", "RJ", "BH", "ES", "PR", "RS", "EP", "VS", "FT", "FEAT", "LP", "OG", "UK", "US"]);
const SMALL = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "em", "no", "na", "nos", "nas", "com", "pra", "pro", "x", "vs"]);

export function looksLikeUrl(s: string): boolean { return /(https?:\/\/|www\.|\.com\b|\.net\b|\.org\b|\.br\b)/i.test(s); }

export function looseEq(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/&/g, " e ").replace(/\band\b/g, " e ").replace(/[^a-z0-9à-ÿ]+/g, "");
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && (y.startsWith(x) || x.startsWith(y)));
}

export function cleanTitle(raw: string): string {
  let s = raw.replace(/\.(mp3|wav|flac|aiff?)$/i, "");
  s = s.replace(/[\(\[]\s*free\s*(download|dl)\s*[\)\]]/gi, "");
  s = s.replace(/\b(free\s*(download|dl))\b/gi, "");
  s = s.replace(/\s+(wav|mp3|flac)\s*$/i, "");
  return s.replace(/\s+/g, " ").replace(/\s*-\s*$/, "").trim();
}

export function smartCase(s: string): string {
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (!letters || letters !== letters.toUpperCase()) return s.trim();
  return s.toLowerCase().split(/\s+/).map((w, i) => {
    const up = w.toUpperCase();
    if (KEEP_UPPER.has(up) || /\d/.test(w)) return up;
    if (i > 0 && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

function profileName(user: string): string {
  if (/^user-\d+$/i.test(user) || looksLikeUrl(user)) return "";
  return smartCase(user.replace(/\s+(oficial|official)$/i, "").trim());
}

export function guessFromSoundCloud(t: ScLike): MetaGuess {
  const clean = cleanTitle(t.title);
  const profile = t.user_name.replace(/\s+(oficial|official)$/i, "");
  let artist = profileName(t.user_name);
  let title = clean;
  const parts = clean.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const head = parts.slice(0, -1).join(" - "), tail = parts[parts.length - 1];
    if (looseEq(tail, profile)) { artist = smartCase(tail); title = head; }
    else if (looseEq(head, profile) || /^(dj|mc)\b/i.test(head)) { artist = smartCase(head); title = parts.slice(1).join(" - "); }
  }
  title = smartCase(title);
  if (looksLikeUrl(artist)) artist = "";
  const dateSrc = t.release_date ?? t.created_at;
  const y = /^(\d{4})/.exec(dateSrc ?? "");
  return { artist, title, album: title, year: y ? parseInt(y[1], 10) : null };
}
```

Ajustar detalhes até os testes passarem (o caso "MC GW e DJ Piu - Bumbum na Nuca" com perfil "DJ PIU": a cabeça contém o perfil e começa com `MC`, cai no segundo ramo).

- [ ] **Step 4: Rodar os testes**

Run: `npm test -- --run src/lib/trackMetaGuess.test.ts`
Expected: 8 testes passam.

- [ ] **Step 5: Commit**

```bash
git add src/lib/trackMetaGuess.ts src/lib/trackMetaGuess.test.ts
git commit -m "feat(crate): sugestao de artista/titulo/ano a partir do SoundCloud (puro, testado)"
```

---

### Task 9: Tela do Crate: seção SoundCloud, card de confirmação, status e fila

**Files:**
- Modify: `src/views/Crate.tsx`
- Modify: `src/views/Crate.test.tsx`
- Modify: `src/styles/extractor-lab.css`
- Modify: `src/components/CommandPalette.tsx` (só o texto da ação, se citar "Soulseek")

**Interfaces:**
- Consumes: `crateScSearch`, `crateScResolve`, `crateScProbe`, `crateScArtwork`, `crateDownload`, `crateSourcesStatus`, tipos (Task 7); `guessFromSoundCloud` (Task 8); `jobs()`/`DownloadJob.source` (Task 7).

- [ ] **Step 1: Escrever os testes que falham**

Em `Crate.test.tsx` (seguir os mocks de `../tauri` já usados no arquivo; acrescentar os mocks dos comandos novos):

```tsx
describe("Crate: SoundCloud", () => {
  it("Enter dispara as duas buscas e renderiza a seção SoundCloud com chip de disponibilidade", async () => {
    mocks.crateScSearch.mockResolvedValue([
      scResult({ id: 1, title: "FESTA DO PENTE RALA - DJ ARANA", user_name: "DJ ARANA OFICIAL", availability: { kind: "native" } }),
      scResult({ id: 2, title: "Sem download", user_name: "X", availability: { kind: "none" } }),
      scResult({ id: 3, title: "No gate", user_name: "Y", availability: { kind: "external_gate", url: "https://hypeddit.com/x" } }),
    ]);
    render(() => <Crate />);
    await typeAndEnter("mandelão");
    expect(mocks.slskSearch).toHaveBeenCalledWith("mandelão", false);
    expect(mocks.crateScSearch).toHaveBeenCalledWith("mandelão");
    const sec = await screen.findByRole("group", { name: /SoundCloud/ });
    expect(within(sec).getAllByRole("button", { name: /Baixar/ })).toHaveLength(1);
    expect(within(sec).getByText("Sem download")).toBeInTheDocument();
    expect(within(sec).getByRole("link", { name: /Abrir/ })).toHaveAttribute("href", "https://hypeddit.com/x");
  });

  it("Baixar abre o card pré-preenchido, sonda o formato e envia crate_download com o metadado confirmado", async () => {
    mocks.crateScSearch.mockResolvedValue([scResult({ id: 1, title: "FESTA DO PENTE RALA - DJ ARANA", user_name: "DJ ARANA OFICIAL", duration_ms: 183000, availability: { kind: "native" }, suggested_dest: "Funk Brasileiro" })]);
    mocks.crateScProbe.mockResolvedValue({ ext: "mp3", size: 7441408, kbps_est: 325, format_label: "MP3 320", allowed: true, reason: null });
    mocks.crateDownload.mockResolvedValue("job-1");
    render(() => <Crate />);
    await typeAndEnter("festa");
    await userEvent.click(await screen.findByRole("button", { name: /Baixar/ }));
    const card = await screen.findByRole("form", { name: /Confirmar faixa/ });
    expect(within(card).getByLabelText("Artista")).toHaveValue("DJ Arana");
    expect(within(card).getByLabelText("Título")).toHaveValue("Festa do Pente Rala");
    expect(within(card).getByLabelText("Ano")).toHaveValue(2024);
    expect(await within(card).findByText(/MP3 320 · 7,1 MB/)).toBeInTheDocument();
    await userEvent.clear(within(card).getByLabelText("Artista"));
    await userEvent.type(within(card).getByLabelText("Artista"), "DJ Arana{enter}");
    expect(mocks.crateDownload).toHaveBeenCalledWith(
      { kind: "sound_cloud", track_id: 1, permalink_url: expect.any(String) },
      { artist: "DJ Arana", title: "Festa do Pente Rala", album: "Festa do Pente Rala", year: 2024, label: null },
      "Funk Brasileiro",
      expect.anything(),
    );
  });

  it("MP3 128 mostra 'não entra' e desabilita Baixar; sem token explica", async () => {
    mocks.crateScSearch.mockResolvedValue([scResult({ id: 1, title: "A", user_name: "B", availability: { kind: "native" }, suggested_dest: "Funk Brasileiro" })]);
    mocks.crateScProbe.mockResolvedValue({ ext: "mp3", size: 3672064, kbps_est: 129, format_label: "MP3 128", allowed: false, reason: "abaixo de 320 kbps" });
    render(() => <Crate />);
    await typeAndEnter("a");
    await userEvent.click(await screen.findByRole("button", { name: /Baixar/ }));
    const card = await screen.findByRole("form", { name: /Confirmar faixa/ });
    expect(await within(card).findByText(/MP3 128 · não entra/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /^Baixar$/ })).toBeDisabled();
    mocks.crateScProbe.mockRejectedValue("no_token");
    await userEvent.click(within(card).getByRole("button", { name: /Cancelar/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Baixar/ }));
    expect(await screen.findByText(/sem token do SoundCloud/)).toBeInTheDocument();
  });

  it("status das fontes aparece no cabeçalho e a fila mostra a origem", async () => {
    mocks.crateSourcesStatus.mockResolvedValue({ soundcloud: "no_token", ffmpeg: true, uv: false, bandcamp_identity: false });
    mocks.slskJobs.mockResolvedValue([job({ job_id: "j", source: { kind: "sound_cloud", track_id: 1, permalink_url: "https://soundcloud.com/a/b" }, display: "DJ Arana - Festa", state: { kind: "downloading", pct: 40, bps: 1000, eta_s: 3 } })]);
    render(() => <Crate />);
    expect(await screen.findByText(/SoundCloud: sem token/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Fila/ }));
    expect(screen.getByText("SoundCloud", { selector: ".crate-src" })).toBeInTheDocument();
    expect(screen.getByText("soundcloud.com/a/b")).toBeInTheDocument();
  });

  it("estado waiting e rejeições novas têm linha própria", async () => {
    mocks.slskJobs.mockResolvedValue([
      job({ job_id: "w", source: { kind: "bandcamp", item_type: "album", item_id: 1, url: "https://x.bandcamp.com/album/y" }, state: { kind: "waiting", reason: "purchase", url: "https://x.bandcamp.com/album/y", since_secs: 10 } }),
      job({ job_id: "r", state: { kind: "rejected", reason: { low_bitrate: { kbps: 128 } } } }),
      job({ job_id: "n", state: { kind: "rejected", reason: "no_download" } }),
    ]);
    render(() => <Crate />);
    await userEvent.click(screen.getByRole("tab", { name: /Fila/ }));
    expect(await screen.findByText(/Aguardando compra no Bandcamp/)).toBeInTheDocument();
    expect(screen.getByText(/MP3 128: abaixo de 320/)).toBeInTheDocument();
    expect(screen.getByText(/sem download nativo/)).toBeInTheDocument();
  });
});
```

`scResult(overrides)` e `job(overrides)` são helpers do teste com todos os campos preenchidos.

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -- --run src/views/Crate.test.tsx`
Expected: os cinco novos falham; os antigos continuam passando (ou falham só pelo campo `username` removido do `DownloadJob`, a ajustar junto).

- [ ] **Step 3: Implementar**

Em `Crate.tsx`:

1. Estado novo: `scResults: ScResult[]`, `scState: "idle" | "loading" | "done" | "empty" | "error"`, `scError: string | null`, `card: { r: ScResult; meta: MetaGuess; probe: ScProbe | null; probeErr: string | null; cover: string | null; dest: string | null } | null`, `sourcesStatus: SourcesStatus | null`, `scJobs: Record<number, string>` (track_id → job_id).
2. `doSearch`: além de `slskSearch`, em paralelo `crateScSearch(q)`; se `q` parecer link do SoundCloud (`/^https?:\/\/(www\.)?soundcloud\.com\//`), chamar `crateScResolve(q)` e pular a busca no slskd. Link do Bandcamp (`bandcamp.com`) nesta fase: `setNotice("Links do Bandcamp chegam na próxima versão.")`.
3. Placeholder: "Buscar no Soulseek e SoundCloud, ou colar link do Bandcamp".
4. Render: antes de `<Show when={groups().length > 0}>`, a seção `<section class="crate-section" role="group" aria-label="SoundCloud">` com cabeçalho "SoundCloud · N" (ou "buscando…" / "nada no SoundCloud" / erro) e `<For each={scResults()}>` de `ScRow`. A seção Soulseek ganha cabeçalho "Soulseek".
5. `ScRow`: título (`cleanTitle`), perfil, duração (`formatDuration`), plays (`toLocaleString("pt-BR")`, `tabular-nums`), ano, `<span class="crate-src">SoundCloud</span>`, chip `.crate-avail` com `data-kind` (native: "Original"; quota_exhausted: "Cota esgotada"; external_gate: "Download externo" + `<a target="_blank" rel="noopener" href=url>Abrir</a>`; none: "Sem download" + link para `permalink_url`), botão Baixar só em `native` e sem job; se há job (`scJobs()[r.id]`), reusar `StateLine` com o job.
6. Card (`ConfirmCard`), aberto na linha (`isCardOpen = card()?.r.id === r.id`): `<form role="form" aria-label="Confirmar faixa" onSubmit=...>` com `<label>Artista<input/></label>`, Título, Ano (`type="number"`), `DestChip` (variant="row") para a playlist, imagem `card.cover` (data URL de `crateScArtwork`, carregada ao abrir, melhor esforço), linha `.crate-fmt`: enquanto `probe == null && !probeErr` → "sondando formato…"; `probe.allowed` → `${format_label} · ${mb} MB`; não permitido → `${format_label} · não entra` (+ `reason`); `probeErr === "no_token"` → "sem token do SoundCloud" com link para a seção de status (`href="#crate-sources"`). Botões: `Baixar` (`type="submit"`, desabilitado se `!probe?.allowed || !artist || !title || !dest`) e `Cancelar`. Enter no form = Baixar; Esc = cancelar (via `pushEscLayer`). Ao abrir: `meta = guessFromSoundCloud(r)`, `dest = r.suggested_dest ?? destOverride() ?? loadLastDest()`, dispara `crateScProbe(r.id, r.duration_ms)` e `crateScArtwork(r.artwork_url)`. Submit: `crateDownload(source, meta, dest, r.artwork_url)`, `setScJobs`, `saveLastDest(dest)`, fecha o card; erro → `setNotice`.
7. Aviso de dedup no card: `slskDedupProbe(`${artist} ${title}`)` ao abrir, com `dedupMatch`; se achar, linha "Já no acervo: …" com botão Tocar; Baixar segue habilitado.
8. Status: `crateSourcesStatus()` no `onMount` e a cada 30 s; renderizar ao lado do indicador de rede: `<span id="crate-sources" class="crate-sources">SoundCloud: {token ok|sem token|API indisponível} · ffmpeg: {ok|ausente}</span>`.
9. `CrateJobRow`: `<span class="crate-src">{sourceName(job.source)}</span>` e subtítulo `sourceSubtitle(job.source)` (peer, ou URL sem `https://`). `StateLine` ganha `waiting` ("Aguardando compra no Bandcamp" / "Link enviado para o seu e-mail", com botão Abrir; os botões "Verificar agora"/"Continuar" ficam para a fase 2 e por ora não aparecem) e as rejeições novas (`low_bitrate` → "MP3 {kbps}: abaixo de 320"; `no_download` → "sem download nativo"). `deriveRowState`/`RowState` ganham `"waiting"`. `IN_FLIGHT` na view e `NON_TERMINAL_KINDS` no store ganham `"waiting"`.
10. CSS (`extractor-lab.css`, perto de `.crate-row`): `.crate-section`, `.crate-section__head` (mesma tipografia do `.crate-list-head h2`), `.crate-src` (badge pequeno, `--fg-3` sobre `--bg-2`, `letter-spacing: .02em`, sem caixa-alta), `.crate-avail[data-kind]` (native: cor de sinal ok do tema; os outros: `--fg-3` e linha com `opacity: .6`), `.crate-card` (grid de 2 colunas: capa 72 px + campos; `gap: var(--sp-2)`; inputs com os tokens de `.coll-search input`), `.crate-fmt` (`tabular-nums`). Nada de valor solto; só tokens já existentes no `:root`/tema.

- [ ] **Step 4: Rodar os testes e o typecheck**

Run: `npm run typecheck && npm test -- --run`
Expected: tudo verde (os testes antigos de `Crate.test.tsx` ajustados ao `DownloadJob` novo).

- [ ] **Step 5: Verificar a classe no bundle**

Run: `npm run build >/dev/null && grep -c "crate-card" dist/assets/*.css`
Expected: `>= 1` (lição do `components.css` órfão: CSS só vale se entrou no bundle).

- [ ] **Step 6: Commit**

```bash
git add src/views/Crate.tsx src/views/Crate.test.tsx src/styles/extractor-lab.css src/store/crate.ts src/components/CommandPalette.tsx
git commit -m "feat(crate): secao SoundCloud, card de confirmacao, status das fontes e origem na fila"
```

---

### Task 10: QA no app real, documentação e release

**Files:**
- Modify: `docs/soulseek/manual-qa.md`
- Modify: `CLAUDE.md` (seção "Aquisicao Bandcamp + SoundCloud" e "Crate")
- Modify: `src-tauri/tauri.conf.json` (bump)

- [ ] **Step 1: Gates completos na VM**

Run:
```bash
cd /home/opc/rustify-player/src-tauri && cargo test --workspace 2>&1 | tail -15
cd /home/opc/rustify-player && npm run typecheck && npm test -- --run 2>&1 | tail -8
```
Expected: zero falhas.

- [ ] **Step 2: Bump e release**

Editar `version` em `src-tauri/tauri.conf.json` (próxima patch, ex. `0.2.87`), commit `chore: bump 0.2.87`, depois `./scripts/release.sh`. Baixar o `.deb` na cmr-auto:

```bash
ssh cmr-auto@100.102.249.9 'V=0.2.87; gh release download -R PedroGiudice/rustify-player -p "rustify-player_${V}_amd64.deb" -D /tmp --clobber && ls -la /tmp/rustify-player_${V}_amd64.deb'
```

- [ ] **Step 3: QA roteirizado (CEO instala; executor valida pela ponte MCP)**

Acrescentar em `docs/soulseek/manual-qa.md` os casos SC-1 a SC-6, cada um com passos e resultado esperado:

- SC-1 busca "mandelão": seção SoundCloud em até 2 s; Soulseek preenchendo; chips corretos.
- SC-2 download de WAV (DJ WIN "Vou Voltar Nada" é WAV, ~24 MB): card "WAV · 23 MB", progresso, Processing, Ready, faixa toca, arquivo em `~/Music/Funk Brasileiro/DJ WIN/2022 - Vou Voltar Nada (MC Braz e Rick)/01 - Vou Voltar Nada (MC Braz e Rick).flac` com tags e `cover.jpg`; Qdrant `embedding_status: done` em até 2 min.
- SC-3 MP3 128 (DJ Piu "Bumbum na Nuca"): "MP3 128 · não entra", Baixar desabilitado.
- SC-4 sem token (renomear `~/.secrets/soundcloud-oauth.txt` temporariamente): status "sem token", card explica, nada baixa; restaurar.
- SC-5 comandos durante download: pela ponte, `slsk_jobs` responde em menos de 2 s enquanto SC-2 baixa.
- SC-6 duplo clique em Baixar: um job só.

Validação pela ponte: `ssh -f -N -o ExitOnForwardFailure=yes -L 9223:localhost:9223 cmr-auto@100.102.249.9`, `driver_session host=127.0.0.1 port=9223`, `webview_screenshot` do Crate com a seção SoundCloud e o card aberto; `ipc_execute_command slsk_jobs` cronometrado durante o download.

- [ ] **Step 4: Documentação viva**

`CLAUDE.md`: na seção "Crate", acrescentar o parágrafo das fontes (SoundCloud in-app, worker `sc-worker`, `sources.json`, status, política de bitrate, `canonical_dest` com `_` nos caracteres do Android); na seção "Aquisicao Bandcamp + SoundCloud", marcar que o SoundCloud agora é in-app e os scripts ficam para leva grande; registrar a fase 2 (Bandcamp) como pendente com a spec.

- [ ] **Step 5: Commit**

```bash
git add docs/soulseek/manual-qa.md CLAUDE.md
git commit -m "docs(crate): QA do SoundCloud in-app e documentacao do fluxo"
```

---

## Auto-revisão do plano

- Cobertura da spec: §2.1 a 2.5 (Tasks 1, 2), §3.1 (Task 3), §3.2 (Task 6), §3.3 (Task 8), §4.1 a 4.4 (Tasks 4, 5, 6), §5.1 a 5.5 (Task 9), §7 (Tasks 5, 7), §8 (todas + Task 10). §6 é a fase 2, fora deste plano por decisão da spec.
- Placeholders: nenhum "TBD"; o único ponto em aberto declarado é a API exata do `lofty` 0.25 (nomes de método), com instrução de conferir pelo `cargo doc`.
- Consistência de tipos: `FetchTask` com `artwork_url` (definido na Task 6, consumido na Task 7); `SlskTask::DownloadExternal` com `artwork_url` (Task 2 ajustada pela Task 6); `probe_original(track_id, token, duration_ms)` (Task 3, usado na Task 6 e 7); `classify_original` (Task 6); `SourcesStatus` (Task 5/7); tipos TS (Task 7, usados na 9).
- Review Focus: os cinco itens têm teste nomeado nas Tasks 2, 4, 5 e 6.
