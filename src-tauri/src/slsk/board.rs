//! board.rs — estado dos jobs de download (fila do Crate).
//!
//! `JobBoard` é o único lugar onde `DownloadJob`s vivem em memória. Escritor
//! único (`upsert`/`transition` são `pub(crate)`, só o coordinator chama);
//! leitura livre via `snapshot()` (usada pelo evento `slsk-jobs` e pelo
//! comando `slsk_jobs`). Ver spec §3.4 (invariantes de concorrência) e §3.5
//! (`JobState` de 11 estados + `RejectReason`).

use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Candidato de download — espelho do `slskd_client::rank::Candidate`, mas
/// com `Serialize`/`Deserialize` (o crate A é PURO, sem serde — este tipo é
/// o de fronteira IPC/persistência; `Deserialize` é pro round-trip de
/// `slsk_jobs.json`). `bit_rate` é derivado (size/duração), não vem do wire
/// da API; `None` quando falta duração pra calcular.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Candidate {
    pub id: String,
    pub username: String,
    pub filename: String,
    pub directory: String,
    pub size: u64,
    pub bit_depth: Option<u16>,
    pub sample_rate: Option<u32>,
    pub bit_rate: Option<u32>,
    pub length_secs: Option<u32>,
    pub free_slot: bool,
    pub upload_speed: u64,
    pub queue_length: u32,
    pub score: i32,
    pub warn: Option<String>,
}

impl From<&slskd_client::rank::Candidate> for Candidate {
    fn from(c: &slskd_client::rank::Candidate) -> Self {
        let bit_rate = c.length_secs.filter(|&l| l > 0).map(|l| {
            ((c.size as f64 * 8.0) / (l as f64) / 1000.0).round() as u32
        });
        Candidate {
            id: c.id.clone(),
            username: c.username.clone(),
            filename: c.filename.clone(),
            directory: c.directory.clone(),
            size: c.size,
            bit_depth: c.bit_depth,
            sample_rate: c.sample_rate,
            bit_rate,
            length_secs: c.length_secs,
            free_slot: c.free_slot,
            upload_speed: c.upload_speed,
            queue_length: c.queue_length,
            score: c.score,
            warn: c.warn.clone(),
        }
    }
}

/// Motivo de rejeição pós-download — decisão, não erro (spec §3.5). Nunca
/// oferecer retry automático pra estes: `AlreadyOwned`/`Bit32Unsupported`
/// nunca vão passar numa segunda tentativa da MESMA fonte.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    AlreadyOwned { track_id: String },
    Bit32Unsupported,
    NotFlac,
    Corrupt,
    /// MP3 original abaixo de 300 kbps (estimado na sondagem ou medido no
    /// arquivo baixado) — não entra no acervo (spec §3, política de lossy).
    LowBitrate { kbps: u32 },
    /// A faixa não tem download nativo (ou a cota acabou) — nada a baixar.
    NoDownload,
}

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
    #[allow(dead_code)] // consumido pela fila da UI (tasks seguintes do plano Crate fase 1)
    pub fn label(&self) -> String {
        match self {
            Source::Soulseek { username, .. } => username.clone(),
            Source::SoundCloud { permalink_url, .. } => permalink_url.clone(),
            Source::Bandcamp { url, .. } => url.clone(),
        }
    }

    /// Chave de identidade (sem `size`: a mesma faixa com tamanho novo é o
    /// mesmo job). A do Soulseek é exatamente a string antiga
    /// `"{username}\u{1}{remote_filename}"`, sem prefixo de origem: jobs já
    /// persistidos em `slsk_jobs.json` mantêm o mesmo `job_id`. As externas
    /// começam com `\u{0}`, que não aparece em username do Soulseek: um peer
    /// chamado "sound_cloud" nunca gera o id de uma faixa do SoundCloud.
    fn identity(&self) -> String {
        match self {
            Source::Soulseek { username, remote_filename, .. } => {
                format!("{username}\u{1}{remote_filename}")
            }
            Source::SoundCloud { track_id, .. } => format!("\u{0}sound_cloud\u{1}{track_id}"),
            Source::Bandcamp { item_type, item_id, .. } => {
                format!("\u{0}bandcamp\u{1}{item_type}\u{1}{item_id}")
            }
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

/// Formato de origem detectado no arquivo baixado (spec §2.1).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormatIn {
    Flac,
    Wav24,
    Wav16,
    Aiff,
    Mp3_320,
}

#[allow(dead_code)] // consumido pelo sc-worker e pela UI (tasks seguintes do plano Crate fase 1)
impl FormatIn {
    pub fn is_lossy(self) -> bool {
        matches!(self, FormatIn::Mp3_320)
    }

    pub fn label(self) -> &'static str {
        match self {
            FormatIn::Flac => "FLAC",
            FormatIn::Wav24 => "WAV 24 bit",
            FormatIn::Wav16 => "WAV",
            FormatIn::Aiff => "AIFF",
            FormatIn::Mp3_320 => "MP3 320",
        }
    }
}

/// Por que um job está em `Waiting` (só Bandcamp, spec §2.2).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WaitReason {
    Purchase,
    EmailLink,
}

/// Estado de um job — 12 variantes (spec §3.5 e §2.2 da spec do Crate com
/// fontes). `tag = "kind"` no wire:
/// `{"kind":"downloading","pct":34.0,"bps":...}`. Terminais (sem transição
/// de saída, ver [`can_transition`]): `Ready`, `Rejected`, `Manual`,
/// `Failed`, `Canceled`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum JobState {
    Queued,
    Enqueued { queue_position: Option<u32> },
    Downloading { pct: f32, bps: u64, eta_s: Option<u32> },
    Stalled { since_secs: u64 },
    Processing,
    Indexing,
    Ready { track_id: String },
    Rejected { reason: RejectReason },
    Manual { path: String, why: String },
    Failed { reason: String, retryable: bool },
    Canceled,
    /// Espera algo de fora do app (compra no Bandcamp, link do e-mail).
    /// Não é terminal e não ocupa vaga de transferência (spec §2.2).
    /// `since_secs` é derivado: o board guarda o instante (unix) de entrada
    /// e recalcula a idade em toda leitura (`snapshot`/`get`). Na escrita,
    /// o valor informado só serve para ancorar uma espera que já vinha de
    /// antes (boot: âncora = agora - `since_secs`).
    Waiting { reason: WaitReason, url: String, since_secs: u64 },
}

fn tag(s: &JobState) -> &'static str {
    match s {
        JobState::Queued => "queued",
        JobState::Enqueued { .. } => "enqueued",
        JobState::Downloading { .. } => "downloading",
        JobState::Stalled { .. } => "stalled",
        JobState::Processing => "processing",
        JobState::Indexing => "indexing",
        JobState::Ready { .. } => "ready",
        JobState::Rejected { .. } => "rejected",
        JobState::Manual { .. } => "manual",
        JobState::Failed { .. } => "failed",
        JobState::Canceled => "canceled",
        JobState::Waiting { .. } => "waiting",
    }
}

const TERMINALS: &[&str] = &["ready", "rejected", "manual", "failed", "canceled"];

/// Matriz de transições legais. Terminal nunca sai (nem pra si mesmo —
/// `Canceled -> Canceled` também é ilegal) — **exceto** a aresta
/// `{failed,rejected} -> queued`, aberta deliberadamente pro `[Tentar outra
/// fonte]`/`[Trocar fonte]` do spec §4.6 (review CR-3: sem essa exceção o
/// botão é inalcançável exatamente nos estados onde a spec o define como
/// ação primária). `Failed`/`Rejected` continuam terminais pra tudo mais —
/// `is_terminal()` não muda, então `retain_recent_terminals`/contagem de
/// in-flight seguem tratando os dois como "em repouso, podável". A janela
/// de corrida (job podado do board antes do clique) resolve em `Err("job
/// não encontrado")`, não em pânico. `Manual`/`Canceled` NÃO ganham essa
/// aresta: `manual` usa `[Abrir pasta]`, `canceled` foi decisão do usuário.
///
/// Não-terminal -> mesmo `tag` é sempre legal (atualização de progresso:
/// `Downloading{34%} -> Downloading{40%}`). O resto é uma tabela explícita:
/// `Queued..Enqueued..Downloading..Processing..Indexing..Ready` é o
/// caminho feliz; `Downloading<->Stalled` é o ciclo de stall/retomada;
/// `{Downloading,Enqueued,Stalled} -> Queued` é o retry automático de fonte
/// (spec §5.6 — a 1ª falha reenfileira em silêncio, só a 2ª vira `Failed`
/// visível).
pub fn can_transition(from: &JobState, to: &JobState) -> bool {
    let (f, t) = (tag(from), tag(to));
    if matches!((f, t), ("failed", "queued") | ("rejected", "queued")) {
        return true;
    }
    if TERMINALS.contains(&f) {
        return false;
    }
    if f == t {
        return true;
    }
    matches!(
        (f, t),
        ("queued", "enqueued")
            | ("queued", "downloading")
            | ("queued", "canceled")
            | ("queued", "failed")
            | ("enqueued", "downloading")
            // Poll pode nunca ver o transfer em "InProgress" entre dois
            // ciclos (arquivo pequeno, ou o poll simplesmente perdeu a
            // janela) — o slskd já reporta "Completed, Succeeded" direto.
            | ("enqueued", "processing")
            | ("enqueued", "stalled")
            | ("enqueued", "canceled")
            | ("enqueued", "failed")
            | ("enqueued", "queued")
            | ("downloading", "stalled")
            | ("downloading", "processing")
            | ("downloading", "canceled")
            | ("downloading", "failed")
            | ("downloading", "queued")
            | ("stalled", "downloading")
            // Mesma razao do enqueued->processing: o job pode ter sido
            // marcado Stalled num ciclo e concluido antes do proximo poll.
            | ("stalled", "processing")
            | ("stalled", "queued")
            | ("stalled", "canceled")
            | ("stalled", "failed")
            | ("processing", "indexing")
            | ("processing", "rejected")
            | ("processing", "canceled")
            | ("processing", "failed")
            | ("indexing", "ready")
            | ("indexing", "failed")
            // Waiting (só Bandcamp, spec §2.2): compra entra logo após a
            // sondagem, e-mail depois do POST do helper; sai quando o item
            // aparece (enqueued), pelo usuário (canceled) ou por erro.
            | ("queued", "waiting")
            | ("enqueued", "waiting")
            | ("downloading", "waiting")
            | ("waiting", "enqueued")
            | ("waiting", "canceled")
            | ("waiting", "failed")
    )
}

/// `true` quando o job não recebe mais nenhuma transição (ver [`TERMINALS`]).
pub fn is_terminal(s: &JobState) -> bool {
    TERMINALS.contains(&tag(s))
}

const IN_FLIGHT: &[&str] = &["enqueued", "downloading", "stalled", "processing", "indexing"];

/// `true` quando o job ocupa vaga de transferência da sua origem: transfer
/// vivo no slskd (Soulseek) ou tarefa entregue ao worker (fontes externas),
/// incluindo o pós-download (`Processing`/`Indexing`). Usado pro gate dos
/// tetos por origem (`MAX_ACTIVE_SOULSEEK` etc.) (review CR-2: contar
/// `Queued` ali causava starvation permanente acima do limite, porque
/// promover um `Queued` não reduzia a contagem de "não-terminal").
/// `Queued` (esperando vaga local, nunca chamou `enqueue`) e os terminais
/// ficam de fora.
pub fn is_in_flight(s: &JobState) -> bool {
    IN_FLIGHT.contains(&tag(s))
}

/// Um download em curso (ou terminado) no Crate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DownloadJob {
    pub job_id: String,
    /// Origem ATUAL do job. Para Soulseek carrega `username`/
    /// `remote_filename`/`size` da fonte em uso — `size` é necessário pro
    /// corpo de `POST /transfers/downloads/{user}` quando `promote_queued`
    /// reenfileira depois de uma vaga abrir (review IM-7: sem isso o
    /// enqueue ia com `size:0`). Trocado inteiro sempre que a fonte troca.
    pub source: Source,
    /// O que o CEO confirmou no card (fontes externas); vazio no Soulseek.
    pub meta: ConfirmedMeta,
    /// Capa da faixa na fonte (SoundCloud: `artwork_url` da API, `-large`),
    /// vinda do card. O worker baixa a versão 500x500 e embute no FLAC;
    /// persistida para o boot redespachar o job com a mesma capa. `None`
    /// no Soulseek (a capa vem do arquivo do peer).
    pub artwork_url: Option<String>,
    /// Formato de origem detectado; `None` até o arquivo ser sondado (e
    /// sempre no Soulseek, onde só FLAC entra).
    pub format_in: Option<FormatIn>,
    /// Faixas do job: 1 para single, n para release do Bandcamp.
    pub tracks: u16,
    pub display: String,
    pub dest_playlist: String,
    pub state: JobState,
    /// Rótulo "FLAC 16/44" da fonte ATUAL — atualizado junto com
    /// `source` na troca de fonte. Vazio em jobs reconciliados de um
    /// `slsk_jobs.json` anterior a este campo (o frontend cai no tamanho
    /// do arquivo nesse caso).
    pub quality_label: String,
    pub alternates: Vec<Candidate>,
    pub tried_source_ids: Vec<String>,
    pub created_at: i64,
    /// Tentativa a que o job pertence. Muda toda vez que o coordinator cria
    /// ou recria o job (contador monotônico do coordinator, nunca reusado
    /// na mesma sessão, nem depois de o job sair do board). O worker de
    /// fonte externa recebe o valor no `FetchTask` e o devolve em todo
    /// `FetchEvent`; evento com tentativa diferente da atual é descartado.
    /// Sem isso, cancelar e baixar de novo a mesma faixa (mesmo `job_id`)
    /// deixava os eventos da tarefa antiga caírem na nova.
    pub attempt: u32,
}

impl DownloadJob {
    /// (username, remote_filename, size) quando a origem é Soulseek.
    pub fn soulseek(&self) -> Option<(&str, &str, u64)> {
        match &self.source {
            Source::Soulseek { username, remote_filename, size } => {
                Some((username.as_str(), remote_filename.as_str(), *size))
            }
            _ => None,
        }
    }
}

/// `DefaultHasher` hex sobre a identidade da origem ([`Source::identity`]) —
/// mesma filosofia de `library_indexer::types::path_to_id` e
/// `slskd_client::rank`'s `candidate_id` (spec §3.4). Enfileirar o mesmo
/// arquivo do mesmo peer (ou a mesma faixa do SoundCloud) duas vezes é
/// idempotente: mesmo `job_id`.
pub fn job_id(source: &Source) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.identity().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Estado de todos os jobs. Escritor único (o coordinator, via `upsert`/
/// `transition`, ambos `pub(crate)`); leitura livre (`snapshot`, `pub`).
#[derive(Default)]
pub struct JobBoard {
    jobs: RwLock<HashMap<String, DownloadJob>>,
    /// Instante (unix) em que cada job em `Waiting` entrou nesse estado.
    /// Fonte da idade da espera (`since_secs`) e do `waiting_since_unix`
    /// persistido: o teto de 24 h da compra (spec §2.3, §6.2) conta a
    /// partir daqui, sem recomeçar a cada gravação ou boot. Só existe
    /// entrada para job em `Waiting`. Ordem de locks: `jobs`, depois este.
    waiting_since: Mutex<HashMap<String, i64>>,
}

/// Relógio de parede em segundos unix.
pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Mantém a âncora do `Waiting` coerente com o estado novo do job: entra em
/// `Waiting` → ancora em `now_unix - since_secs` (se já estava esperando,
/// a âncora antiga fica); qualquer outro estado → some.
fn anchor_waiting(waiting: &mut HashMap<String, i64>, id: &str, state: &JobState, now_unix: i64) {
    match state {
        JobState::Waiting { since_secs, .. } => {
            waiting
                .entry(id.to_string())
                .or_insert(now_unix - i64::try_from(*since_secs).unwrap_or(0));
        }
        _ => {
            waiting.remove(id);
        }
    }
}

/// Recalcula `since_secs` do `Waiting` a partir da âncora.
fn with_live_age(mut j: DownloadJob, waiting: &HashMap<String, i64>, now_unix: i64) -> DownloadJob {
    if let JobState::Waiting { since_secs, .. } = &mut j.state {
        if let Some(t) = waiting.get(&j.job_id) {
            *since_secs = u64::try_from(now_unix - t).unwrap_or(0);
        }
    }
    j
}

impl JobBoard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot ordenado por `created_at` — determinístico entre chamadas,
    /// não depende da ordem de iteração do `HashMap`. Usado pelo evento
    /// `slsk-jobs` (board inteiro, não diffs — spec §3.5) e por `slsk_jobs`.
    pub fn snapshot(&self) -> Vec<DownloadJob> {
        self.snapshot_at(unix_now())
    }

    /// [`Self::snapshot`] com o relógio injetado (idade do `Waiting`).
    pub(crate) fn snapshot_at(&self, now_unix: i64) -> Vec<DownloadJob> {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        let waiting = self.waiting_since.lock().unwrap_or_else(|p| p.into_inner());
        let mut v: Vec<DownloadJob> =
            guard.values().map(|j| with_live_age(j.clone(), &waiting, now_unix)).collect();
        v.sort_by_key(|j| j.created_at);
        v
    }

    pub(crate) fn upsert(&self, j: DownloadJob) {
        self.upsert_at(j, unix_now());
    }

    /// [`Self::upsert`] com o relógio injetado: o boot restaura um `Waiting`
    /// com a idade calculada para o mesmo `now_unix`, e a âncora volta
    /// exatamente ao instante persistido.
    pub(crate) fn upsert_at(&self, j: DownloadJob, now_unix: i64) {
        let mut guard = self.jobs.write().unwrap_or_else(|p| p.into_inner());
        let mut waiting = self.waiting_since.lock().unwrap_or_else(|p| p.into_inner());
        anchor_waiting(&mut waiting, &j.job_id, &j.state, now_unix);
        guard.insert(j.job_id.clone(), j);
    }

    /// Instante (unix) em que o job entrou em `Waiting`; `None` fora dele.
    pub(crate) fn waiting_since_unix(&self, id: &str) -> Option<i64> {
        self.waiting_since.lock().unwrap_or_else(|p| p.into_inner()).get(id).copied()
    }

    /// Aplica a transição SE for legal (ver [`can_transition`]). Devolve
    /// `false` sem mutar nada quando o job não existe ou a transição é
    /// ilegal — nunca panica, o coordinator decide o que fazer com `false`
    /// (tipicamente: log + ignora, o board não é fonte de verdade de erro).
    pub(crate) fn transition(&self, id: &str, s: JobState) -> bool {
        self.transition_at(id, s, unix_now())
    }

    /// [`Self::transition`] com o relógio injetado (âncora do `Waiting`).
    pub(crate) fn transition_at(&self, id: &str, s: JobState, now_unix: i64) -> bool {
        let mut guard = self.jobs.write().unwrap_or_else(|p| p.into_inner());
        match guard.get_mut(id) {
            Some(job) if can_transition(&job.state, &s) => {
                let mut waiting = self.waiting_since.lock().unwrap_or_else(|p| p.into_inner());
                anchor_waiting(&mut waiting, id, &s, now_unix);
                job.state = s;
                true
            }
            _ => false,
        }
    }

    pub(crate) fn get(&self, id: &str) -> Option<DownloadJob> {
        self.get_at(id, unix_now())
    }

    /// [`Self::get`] com o relógio injetado (idade do `Waiting`).
    pub(crate) fn get_at(&self, id: &str, now_unix: i64) -> Option<DownloadJob> {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        let waiting = self.waiting_since.lock().unwrap_or_else(|p| p.into_inner());
        guard.get(id).map(|j| with_live_age(j.clone(), &waiting, now_unix))
    }

    /// Sem chamador de produção desde o fix round 2 (NB-1): `create_or_get_job`
    /// passou a usar `get` direto pra também inspecionar o `state` (idempotência
    /// real depende de saber se o job existente é terminal ou não, não só se existe).
    #[allow(dead_code)]
    pub(crate) fn contains(&self, id: &str) -> bool {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard.contains_key(id)
    }

    /// Jobs em estado NÃO-terminal — usado pra gatear os tetos de transferências
    /// e pra montar `alive_job_ids` da limpeza de `.rustify-incoming` no
    /// boot.
    pub(crate) fn active_ids(&self) -> Vec<String> {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard
            .values()
            .filter(|j| !is_terminal(&j.state))
            .map(|j| j.job_id.clone())
            .collect()
    }

    pub(crate) fn active_count(&self) -> usize {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard.values().filter(|j| !is_terminal(&j.state)).count()
    }

    /// Jobs que ocupam vaga de transferência da sua origem (`is_in_flight`,
    /// todas as origens — exclui `Queued`, `Waiting` e terminais). Sem chamador de produção desde o fix round 2 (NB-2):
    /// `fail_network_dependent_jobs` precisa de um conjunto MAIS ESTREITO
    /// (só `Enqueued`/`Downloading`/`Stalled`, não `Processing`/`Indexing`)
    /// e filtra direto por `state`.
    #[allow(dead_code)]
    pub(crate) fn in_flight_ids(&self) -> Vec<String> {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard
            .values()
            .filter(|j| is_in_flight(&j.state))
            .map(|j| j.job_id.clone())
            .collect()
    }

    /// Contagem global (todas as origens). Sem chamador de produção desde
    /// os tetos por origem ([`Self::in_flight_count_for`]); fica para os testes.
    #[allow(dead_code)]
    pub(crate) fn in_flight_count(&self) -> usize {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard.values().filter(|j| is_in_flight(&j.state)).count()
    }

    /// `in_flight_count` restrito a uma origem (`Source::kind`): cada fonte
    /// tem o seu teto e uma não ocupa vaga da outra (spec §2.4).
    pub(crate) fn in_flight_count_for(&self, kind: &str) -> usize {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard
            .values()
            .filter(|j| is_in_flight(&j.state) && j.source.kind() == kind)
            .count()
    }

    /// `true` quando a tentativa `attempt` do job não deve continuar: o job
    /// foi cancelado, foi recriado (outra tentativa) ou saiu do board
    /// ("Limpar concluídos" remove os cancelados). O worker de fonte externa
    /// consulta antes de cada etapa (via `Arc<JobBoard>`) para abandonar o
    /// trabalho e não gastar banda com um resultado que seria descartado.
    pub(crate) fn is_canceled(&self, id: &str, attempt: u32) -> bool {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard
            .get(id)
            .map(|j| j.attempt != attempt || matches!(j.state, JobState::Canceled))
            .unwrap_or(true)
    }

    /// Mantém só os `cap` terminais mais recentes (FIFO por `created_at`) —
    /// `JOBS_RETAINED` (spec §6.4): o board não cresce sem limite numa
    /// sessão longa. Jobs ativos nunca são removidos aqui.
    pub(crate) fn retain_recent_terminals(&self, cap: usize) {
        let mut guard = self.jobs.write().unwrap_or_else(|p| p.into_inner());
        let mut terminal_ids: Vec<(String, i64)> = guard
            .values()
            .filter(|j| is_terminal(&j.state))
            .map(|j| (j.job_id.clone(), j.created_at))
            .collect();
        if terminal_ids.len() <= cap {
            return;
        }
        terminal_ids.sort_by_key(|(_, created_at)| *created_at);
        let to_remove = terminal_ids.len() - cap;
        for (id, _) in terminal_ids.into_iter().take(to_remove) {
            guard.remove(&id);
        }
    }

    /// Remove todos os jobs terminais, devolvendo quantos saíram —
    /// implementa `slsk_clear_finished`.
    pub(crate) fn clear_finished(&self) -> u32 {
        let mut guard = self.jobs.write().unwrap_or_else(|p| p.into_inner());
        let before = guard.len();
        guard.retain(|_, j| !is_terminal(&j.state));
        (before - guard.len()) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, state: JobState) -> DownloadJob {
        DownloadJob {
            job_id: id.to_string(),
            source: Source::Soulseek {
                username: "peer".into(),
                remote_filename: format!("{id}.flac"),
                size: 1,
            },
            meta: ConfirmedMeta::default(),
            artwork_url: None,
            format_in: None,
            tracks: 1,
            display: id.to_string(),
            dest_playlist: "Rap & Hip-Hop".into(),
            state,
            quality_label: String::new(),
            alternates: Vec::new(),
            tried_source_ids: Vec::new(),
            created_at: 0,
            attempt: 0,
        }
    }

    /// Cópia da implementação antiga de `job_id(username, remote_filename)`:
    /// prova que jobs Soulseek já persistidos mantêm o mesmo id.
    fn legacy_job_id(username: &str, remote_filename: &str) -> String {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        format!("{username}\u{1}{remote_filename}").hash(&mut hasher);
        format!("{:x}", hasher.finish())
    }

    fn slsk(username: &str, remote_filename: &str) -> Source {
        Source::Soulseek { username: username.into(), remote_filename: remote_filename.into(), size: 1_000 }
    }

    #[test]
    fn job_id_is_deterministic() {
        let a = job_id(&slsk("peer_a", "Artist - Title.flac"));
        let b = job_id(&slsk("peer_a", "Artist - Title.flac"));
        assert_eq!(a, b);

        let different_user = job_id(&slsk("peer_b", "Artist - Title.flac"));
        assert_ne!(a, different_user);

        let different_file = job_id(&slsk("peer_a", "Other - Track.flac"));
        assert_ne!(a, different_file);
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
    fn identidade_externa_nao_colide_com_peer_soulseek() {
        // Peer chamado "sound_cloud" com arquivo "42" na raiz: a identidade
        // Soulseek (sem prefixo, por compatibilidade) não pode bater com a
        // da faixa 42 do SoundCloud, nem com um álbum do Bandcamp.
        let peer = Source::Soulseek { username: "sound_cloud".into(), remote_filename: "42".into(), size: 1 };
        let sc = Source::SoundCloud { track_id: 42, permalink_url: "https://soundcloud.com/x/y".into() };
        assert_ne!(job_id(&peer), job_id(&sc));
        let peer_bc = Source::Soulseek { username: "bandcamp".into(), remote_filename: "a\u{1}9".into(), size: 1 };
        let bc = Source::Bandcamp { item_type: "a".into(), item_id: 9, url: "https://x.bandcamp.com/album/y".into() };
        assert_ne!(job_id(&peer_bc), job_id(&bc));
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
    fn waiting_guarda_o_instante_de_entrada_e_a_idade_e_calculada_na_leitura() {
        let board = JobBoard::new();
        board.upsert(job("w", JobState::Queued));
        let t0 = 1_000_000;
        let w = JobState::Waiting { reason: WaitReason::Purchase, url: "https://x".into(), since_secs: 0 };
        assert!(board.transition_at("w", w, t0));
        assert_eq!(board.waiting_since_unix("w"), Some(t0));
        let idade = |now| match board.get_at("w", now).unwrap().state {
            JobState::Waiting { since_secs, .. } => since_secs,
            other => panic!("estado: {other:?}"),
        };
        assert_eq!(idade(t0 + 90), 90, "a idade anda com o relógio, não fica congelada");
        match &board.snapshot_at(t0 + 120)[0].state {
            JobState::Waiting { since_secs, .. } => assert_eq!(*since_secs, 120),
            other => panic!("estado: {other:?}"),
        }
        // Regravar o job sem sair de `Waiting` não reinicia a espera.
        let mesmo = board.get_at("w", t0 + 200).unwrap();
        board.upsert_at(mesmo, t0 + 200);
        assert_eq!(board.waiting_since_unix("w"), Some(t0));
        // Restaurado com idade conhecida: âncora = agora - idade.
        let fresco = JobBoard::new();
        let r = job("r", JobState::Waiting { reason: WaitReason::Purchase, url: "https://x".into(), since_secs: 300 });
        fresco.upsert_at(r, t0);
        assert_eq!(fresco.waiting_since_unix("r"), Some(t0 - 300));
        // Sair de `Waiting` apaga a âncora.
        assert!(board.transition_at("w", JobState::Canceled, t0 + 300));
        assert_eq!(board.waiting_since_unix("w"), None);
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

    #[test]
    fn in_flight_count_for_separa_origens() {
        let board = JobBoard::new();
        board.upsert(job("s1", JobState::Downloading { pct: 1.0, bps: 1, eta_s: None }));
        let mut sc = job("c1", JobState::Enqueued { queue_position: None });
        sc.source = Source::SoundCloud { track_id: 1, permalink_url: "https://soundcloud.com/a/1".into() };
        board.upsert(sc);
        assert_eq!(board.in_flight_count_for("soulseek"), 1);
        assert_eq!(board.in_flight_count_for("sound_cloud"), 1);
        assert_eq!(board.in_flight_count_for("bandcamp"), 0);
        assert!(!board.is_canceled("c1", 0));
        assert!(board.transition("c1", JobState::Canceled));
        assert!(board.is_canceled("c1", 0));
    }

    #[test]
    fn is_canceled_cobre_tentativa_trocada_e_job_ausente() {
        let board = JobBoard::new();
        let mut j = job("c2", JobState::Downloading { pct: 1.0, bps: 1, eta_s: None });
        j.attempt = 7;
        board.upsert(j);
        assert!(!board.is_canceled("c2", 7));
        // O job foi recriado (outra tentativa): o worker da tentativa velha para.
        assert!(board.is_canceled("c2", 6));
        // Job removido ("Limpar concluídos"): o worker também para.
        assert!(board.is_canceled("fantasma", 0));
        assert!(board.transition("c2", JobState::Canceled));
        assert_eq!(board.clear_finished(), 1);
        assert!(board.is_canceled("c2", 7));
    }

    #[test]
    fn can_transition_matrix() {
        // Legais: caminho feliz completo.
        assert!(can_transition(&JobState::Queued, &JobState::Enqueued { queue_position: None }));
        assert!(can_transition(
            &JobState::Enqueued { queue_position: Some(3) },
            &JobState::Downloading { pct: 0.0, bps: 0, eta_s: None }
        ));
        assert!(can_transition(
            &JobState::Downloading { pct: 50.0, bps: 100, eta_s: None },
            &JobState::Processing
        ));
        assert!(can_transition(&JobState::Processing, &JobState::Indexing));
        assert!(can_transition(
            &JobState::Indexing,
            &JobState::Ready { track_id: "42".to_string() }
        ));

        // Downloading <-> Stalled (ciclo de stall/retomada).
        assert!(can_transition(
            &JobState::Downloading { pct: 10.0, bps: 0, eta_s: None },
            &JobState::Stalled { since_secs: 120 }
        ));
        assert!(can_transition(
            &JobState::Stalled { since_secs: 120 },
            &JobState::Downloading { pct: 10.0, bps: 500, eta_s: None }
        ));

        // Ilegais.
        assert!(!can_transition(
            &JobState::Ready { track_id: "1".to_string() },
            &JobState::Downloading { pct: 0.0, bps: 0, eta_s: None }
        ));
        assert!(!can_transition(&JobState::Canceled, &JobState::Canceled));
        assert!(!can_transition(&JobState::Canceled, &JobState::Queued));
        assert!(!can_transition(
            &JobState::Canceled,
            &JobState::Ready { track_id: "1".to_string() }
        ));

        // CR-3: excecao estreita — failed/rejected -> queued e legal (o
        // [Tentar outra fonte]/[Trocar fonte] do §4.6), mas so essa aresta.
        assert!(can_transition(
            &JobState::Failed { reason: "x".to_string(), retryable: false },
            &JobState::Queued
        ));
        assert!(can_transition(
            &JobState::Rejected { reason: RejectReason::Bit32Unsupported },
            &JobState::Queued
        ));
        // Continuam terminais pra tudo mais — nao viram porta aberta.
        assert!(!can_transition(
            &JobState::Failed { reason: "x".to_string(), retryable: false },
            &JobState::Enqueued { queue_position: None }
        ));
        assert!(!can_transition(
            &JobState::Failed { reason: "x".to_string(), retryable: false },
            &JobState::Failed { reason: "x".to_string(), retryable: false }
        ));
        // Manual/Canceled NAO ganham a excecao — so failed/rejected.
        assert!(!can_transition(
            &JobState::Manual { path: "p".to_string(), why: "w".to_string() },
            &JobState::Queued
        ));
        assert!(!can_transition(&JobState::Canceled, &JobState::Queued));
    }

    #[test]
    fn is_terminal_unchanged_by_cr3_exception() {
        // A excecao de can_transition NAO deve mudar is_terminal — Failed/
        // Rejected continuam contando como terminal pra pruning/in-flight.
        assert!(is_terminal(&JobState::Failed { reason: "x".to_string(), retryable: false }));
        assert!(is_terminal(&JobState::Rejected { reason: RejectReason::NotFlac }));
    }

    #[test]
    fn transition_applies_legal_ignores_illegal() {
        let board = JobBoard::new();
        board.upsert(job("j1", JobState::Queued));

        assert!(board.transition("j1", JobState::Enqueued { queue_position: Some(1) }));
        assert_eq!(board.get("j1").unwrap().state, JobState::Enqueued { queue_position: Some(1) });

        // Ready é ilegal a partir de Enqueued diretamente — nada muda.
        let illegal = board.transition("j1", JobState::Ready { track_id: "9".to_string() });
        assert!(!illegal);
        assert_eq!(board.get("j1").unwrap().state, JobState::Enqueued { queue_position: Some(1) });

        // Job inexistente: false, sem panic.
        assert!(!board.transition("ghost", JobState::Canceled));
    }

    #[test]
    fn snapshot_sorted_by_created_at() {
        let board = JobBoard::new();
        let mut j2 = job("j2", JobState::Queued);
        j2.created_at = 200;
        let mut j1 = job("j1", JobState::Queued);
        j1.created_at = 100;
        board.upsert(j2);
        board.upsert(j1);

        let snap = board.snapshot();
        assert_eq!(snap[0].job_id, "j1");
        assert_eq!(snap[1].job_id, "j2");
    }

    #[test]
    fn active_count_ignores_terminals() {
        let board = JobBoard::new();
        board.upsert(job("active", JobState::Downloading { pct: 1.0, bps: 1, eta_s: None }));
        board.upsert(job("done", JobState::Ready { track_id: "1".to_string() }));
        board.upsert(job("canceled", JobState::Canceled));

        assert_eq!(board.active_count(), 1);
        assert_eq!(board.active_ids(), vec!["active".to_string()]);
    }

    #[test]
    fn in_flight_count_excludes_queued_and_terminals() {
        // CR-2: Queued NAO conta como in-flight — sem isso, promover um
        // Queued nunca reduzia a contagem de "nao-terminal" e a fila
        // travava permanentemente acima do teto de transferências da origem.
        let board = JobBoard::new();
        board.upsert(job("q1", JobState::Queued));
        board.upsert(job("q2", JobState::Queued));
        board.upsert(job("enq", JobState::Enqueued { queue_position: None }));
        board.upsert(job("dl", JobState::Downloading { pct: 1.0, bps: 1, eta_s: None }));
        board.upsert(job("done", JobState::Ready { track_id: "1".to_string() }));

        assert_eq!(board.in_flight_count(), 2);
        let mut ids = board.in_flight_ids();
        ids.sort();
        assert_eq!(ids, vec!["dl".to_string(), "enq".to_string()]);
        // active_count (mais amplo) continua contando Queued tambem.
        assert_eq!(board.active_count(), 4);
    }

    #[test]
    fn retain_recent_terminals_trims_oldest_fifo() {
        let board = JobBoard::new();
        for i in 0..5u32 {
            let mut j = job(&format!("t{i}"), JobState::Canceled);
            j.created_at = i as i64;
            board.upsert(j);
        }
        board.retain_recent_terminals(3);
        let mut remaining: Vec<String> = board.snapshot().into_iter().map(|j| j.job_id).collect();
        remaining.sort();
        assert_eq!(remaining, vec!["t2".to_string(), "t3".to_string(), "t4".to_string()]);
    }

    #[test]
    fn clear_finished_removes_only_terminals() {
        let board = JobBoard::new();
        board.upsert(job("active", JobState::Downloading { pct: 1.0, bps: 1, eta_s: None }));
        board.upsert(job("done", JobState::Ready { track_id: "1".to_string() }));
        let removed = board.clear_finished();
        assert_eq!(removed, 1);
        assert_eq!(board.snapshot().len(), 1);
        assert_eq!(board.snapshot()[0].job_id, "active");
    }
}
