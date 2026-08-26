//! Continuidade da fila no aparelho — "a música não para".
//!
//! O motor já existia (mobile_intel: cosine + rank_pool + weighted_pick) e
//! estava parado por falta de CAMINHO, não de algoritmo: a fila só podia ser
//! substituída e quem decidiria o próximo lote era o JS, que o Android
//! suspende com a tela apagada.
//!
//! A decisão mora aqui, numa thread Rust do processo do app — mesmo padrão já
//! provado do `mobile_sync::worker`. Ela lê o estado do player pelo plugin,
//! consulta a `MobileLibrary` e anexa o lote seguinte.
//!
//! **Limite conhecido:** o plugin é escopado na Activity. Se o app for tirado
//! dos recentes, o `MediaController` cai e o tender passa a receber erro (não
//! trava — desde a correção do `withController` os invokes são rejeitados). O
//! caso dominante — tela apagada, Activity viva em background — é coberto. Se
//! a medição no aparelho mostrar que a Activity morre com frequência, o
//! gatilho migra para o `AudioService.onEvents` (plano B do epic).

use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Condvar, Mutex};

/// Quantas posições antes do fim já disparam o reabastecimento. 2 dá tempo de
/// a decisão e o IPC acontecerem antes de a fila secar de fato.
pub const SLACK: i32 = 2;
/// Lote de station (espelha o desktop).
pub const STATION_BATCH: usize = 6;
/// Lote de rádio semeado pela última faixa.
pub const RADIO_BATCH: usize = 4;
/// Teto do conjunto de já-vistas: sem isso a sessão longa acaba excluindo o
/// acervo inteiro e o rádio seca por conta própria.
pub const SEEN_CAP: usize = 300;
/// Abaixo desta fração da faixa, largar é rejeição — acima, é só impaciência
/// no fim. Mesmo limiar do desktop (`SESSION_REJECT_RATIO` em radioSession.ts).
pub const SESSION_REJECT_RATIO: f64 = 0.35;
/// Quantas rejeições da sessão pesam no ranking (espelha o SKIPPED_CAP do
/// desktop). Mais que isso e a sessão inteira vira negativa.
pub const SESSION_NEG_CAP: usize = 15;
/// Depois disto o cursor do tender é considerado morto e o sync deixa de
/// esperar por ele. Segurar o journal para sempre é pior que perder a reação.
pub const CURSOR_STALE_MS: i64 = 180_000;
/// Cursor ainda não posicionado. O journal guarda tudo que o sync não ackou —
/// inclusive skips de horas atrás. Começar em 0 faria a rodada nova nascer
/// carregando rejeições do passado (medido no S24: o cap de 15 já saturado
/// antes do primeiro skip). Rejeição de sessão é da sessão.
pub const CURSOR_UNSET: i64 = -1;
/// Teto do anel de tocadas recentes (espelha o desktop).
pub const RECENTS_CAP: usize = 300;
/// Por quanto tempo uma faixa tocada fica fora do rádio.
pub const RECENTS_TTL_S: i64 = 7 * 86_400;
/// A partir de quanto uma escuta CONTA como play para a shelf "Recently
/// played" (CMR-215): 20s OU 25% da faixa — o que vier primeiro. Decisão do
/// plano de paridade (15/08); o skit de 25s conta, o skip aos 3s não.
pub const MIN_PLAY_MS: i64 = 20_000;
pub const MIN_PLAY_PCT: f64 = 0.25;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// Sem continuidade armada (fila comum que o usuário montou).
    Off,
    /// Rádio semeado por uma faixa.
    Radio { seed_track_id: u64 },
    /// Station exportada do desktop.
    Station { station_id: String },
}

#[derive(Debug)]
pub struct Continuity {
    pub enabled: bool,
    pub mode: Mode,
    pub context_id: Option<String>,
    /// Ids já enfileirados nesta rodada — evita repetir na mesma sessão.
    pub seen: Vec<u64>,
    pub last_topup_at: i64,
    pub last_error: Option<String>,
    /// Até onde o tender já leu o journal do plugin. É um cursor de LEITURA:
    /// quem compacta o journal é o worker de sync, e ele espera por este
    /// valor (ver [`ack_ceiling`]) para não apagar um skip antes da reação.
    pub journal_cursor: i64,
    /// Quando o cursor avançou pela última vez (epoch ms).
    pub cursor_at: i64,
    /// O que foi largado cedo NESTA sessão, mais recente primeiro. Não é o
    /// mesmo que os negatives do gosto: some quando a rodada acaba.
    pub session_negatives: Vec<u64>,
    /// Um skip chegou pelo app e ainda não foi processado pelo ciclo.
    pub reaction_pending: bool,
}

impl Default for Continuity {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: Mode::Off,
            context_id: None,
            seen: Vec::new(),
            last_topup_at: 0,
            last_error: None,
            journal_cursor: CURSOR_UNSET,
            cursor_at: 0,
            session_negatives: Vec::new(),
            reaction_pending: false,
        }
    }
}

impl Continuity {
    /// Registra ids como vistos, respeitando o teto (descarta os mais antigos).
    pub fn remember(&mut self, ids: impl IntoIterator<Item = u64>) {
        let known: HashSet<u64> = self.seen.iter().copied().collect();
        for id in ids {
            if !known.contains(&id) {
                self.seen.push(id);
            }
        }
        if self.seen.len() > SEEN_CAP {
            let excess = self.seen.len() - SEEN_CAP;
            self.seen.drain(0..excess);
        }
    }

    /// Marca uma faixa como rejeitada nesta sessão. Repetir sobe de novo pro
    /// topo (a rejeição mais fresca é a que mais pesa) e o teto corta a cauda.
    pub fn note_negative(&mut self, id: u64) {
        self.session_negatives.retain(|&x| x != id);
        self.session_negatives.insert(0, id);
        self.session_negatives.truncate(SESSION_NEG_CAP);
    }
}

/// Anel de tocadas recentes — memória CROSS-sessão do rádio ("não repete o
/// que tocou nos últimos dias"). Diferente do `seen` (rodada) e dos
/// `session_negatives` (rejeição): aqui entra tudo que tocou, de qualquer
/// origem, e expira sozinho pelo TTL. Persistido em `<data_dir>/recents.json`
/// (`{"ids":[{"id":"<u64 como string>","at":<epoch_s>,"played_at":<epoch_s>?}]}`).
///
/// Desde o CMR-215 o mesmo anel alimenta a shelf "Recently played" da Home:
/// `at` continua sendo o relógio do rádio (fim da última escuta, de qualquer
/// tamanho) e `played_at` marca o INÍCIO da última escuta que CONTOU como play
/// ([`counts_as_play`]). Os dois consumidores leem campos distintos — o
/// contrato do rádio (`ids`/TTL/cap) não muda.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RecentsRing {
    ids: Vec<RecentEntry>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RecentEntry {
    /// String no disco pelo mesmo motivo de sempre: u64 > 2^53 corrompe se
    /// algum dia um consumidor JS ler este arquivo.
    pub id: String,
    /// Fim da última escuta (epoch s) — relógio do TTL do rádio.
    pub at: i64,
    /// Início da última escuta que contou como play. `None` = só skips cedo
    /// (ou entrada legada, gravada antes do campo existir): fica no rádio e
    /// fora da shelf.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub played_at: Option<i64>,
}

impl RecentsRing {
    /// Registra uma escuta. Uma escuta mais NOVA renova o relógio do rádio
    /// (`at`) e move a entrada pro fim — o anel é ordenado por `at` e o cap
    /// expulsa pela frente; evento mais velho que o relógio (o sync re-drena
    /// do zero) nem move nem regride. A poda roda na escrita — cap e TTL
    /// nunca ficam para depois.
    ///
    /// `played_at` é STICKY: um skip cedo posterior (`None`) renova `at` mas
    /// não apaga o play que contou antes. Devolve `true` se algo mudou no
    /// anel — inclusive quando só a poda removeu alguém: dois feeders leem o
    /// mesmo journal e o segundo não deve reescrever o arquivo à toa, mas uma
    /// entrada expirada precisa sumir do disco.
    pub fn push(&mut self, id: u64, now_s: i64, played_at: Option<i64>) -> bool {
        let s = id.to_string();
        let antes = self.ids.len();
        let mut mudou = match self.ids.iter().position(|e| e.id == s) {
            None => {
                self.ids.push(RecentEntry { id: s, at: now_s, played_at });
                true
            }
            Some(i) => {
                let e = &mut self.ids[i];
                // Feeders podem se sobrepor fora de ordem: o play mais
                // recente sempre vence.
                let played = match (e.played_at, played_at) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                };
                let mudou_play = played != e.played_at;
                e.played_at = played;
                if now_s > e.at {
                    e.at = now_s;
                    let entry = self.ids.remove(i);
                    self.ids.push(entry);
                    true
                } else {
                    mudou_play
                }
            }
        };
        self.prune(now_s);
        mudou |= self.ids.len() != antes;
        mudou
    }

    /// Ids que CONTARAM como play dentro do TTL, do mais recente pro mais
    /// antigo (ordem estável), no máximo `limit`. É a shelf "Recently played".
    pub fn recent_play_ids(&self, now_s: i64, limit: usize) -> Vec<String> {
        let mut played: Vec<(&str, i64)> = self
            .ids
            .iter()
            .filter_map(|e| e.played_at.map(|p| (e.id.as_str(), p)))
            .filter(|(_, p)| now_s.saturating_sub(*p) <= RECENTS_TTL_S)
            .collect();
        played.sort_by(|a, b| b.1.cmp(&a.1));
        played.into_iter().take(limit).map(|(id, _)| id.to_string()).collect()
    }

    pub fn prune(&mut self, now_s: i64) {
        self.ids.retain(|e| now_s.saturating_sub(e.at) <= RECENTS_TTL_S);
        if self.ids.len() > RECENTS_CAP {
            let excess = self.ids.len() - RECENTS_CAP;
            self.ids.drain(0..excess);
        }
    }

    pub fn ids(&self) -> Vec<String> {
        self.ids.iter().map(|e| e.id.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn from_json(bytes: &[u8]) -> Self {
        serde_json::from_slice(bytes).unwrap_or_default()
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
}

/// Estado compartilhado + o sino que acorda o tender. Sem o sino, um skip
/// feito dentro do app esperaria o ciclo inteiro (20s) para virar reação — o
/// usuário veria a fila velha e concluiria que não fez nada.
#[derive(Debug, Default)]
pub struct ContinuityState {
    pub inner: Mutex<Continuity>,
    /// Tocadas recentes (cross-sessão). Mutex próprio: quem escreve aqui é o
    /// worker de sync, o tender e o `lib_recent_plays`; o `inner` não precisa
    /// esperar por eles.
    pub recents: Mutex<RecentsRing>,
    recents_path: Mutex<Option<std::path::PathBuf>>,
    /// Até onde o `lib_recent_plays` já leu o journal. Só em MEMÓRIA, de
    /// propósito: o `seq` é monotônico por INSTALAÇÃO (o contador vive nas
    /// prefs do plugin) — a compactação do journal não o reseta; só
    /// reinstalar/limpar dados, que também reinicia este processo. Um cursor
    /// persistido sobreviveria a isso e pularia tudo; avançar pelo `last_seq`
    /// do drain é seguro.
    recents_seq: AtomicI64,
    wake_flag: Mutex<bool>,
    wake_cv: Condvar,
}

impl ContinuityState {
    /// Carrega o anel do disco e memoriza o caminho pras escritas futuras.
    pub fn load_recents(&self, path: std::path::PathBuf) {
        let ring = std::fs::read(&path).map(|b| RecentsRing::from_json(&b)).unwrap_or_default();
        if let Ok(mut r) = self.recents.lock() {
            *r = ring;
        }
        if let Ok(mut p) = self.recents_path.lock() {
            *p = Some(path);
        }
    }

    /// Registra escutas e persiste. Write-through: é ~1 escrita por faixa
    /// tocada, e perder o anel num kill do app é perder o "não repete". Só
    /// toca o disco se o anel mudou — os feeders leem o mesmo journal e o
    /// segundo a chegar não tem nada de novo. A escrita é atômica
    /// (`.tmp` + rename, como o compact do EventJournal): um kill no meio
    /// não deixa o arquivo meio-escrito, que o boot leria como anel vazio.
    pub fn remember_recents(&self, items: impl IntoIterator<Item = (u64, i64, Option<i64>)>) {
        let Ok(mut r) = self.recents.lock() else { return };
        let mut mudou = false;
        for (id, at, played_at) in items {
            mudou |= r.push(id, at, played_at);
        }
        if !mudou {
            return;
        }
        let path = self.recents_path.lock().ok().and_then(|p| p.clone());
        if let Some(p) = path {
            if let Err(e) = write_atomic(&p, &r.to_json()) {
                tracing::warn!(%e, "recents: falha ao persistir");
            }
        }
    }

    pub fn recent_ids(&self) -> Vec<String> {
        self.recents.lock().map(|r| r.ids()).unwrap_or_default()
    }

    /// Shelf "Recently played": ver [`RecentsRing::recent_play_ids`].
    pub fn recent_play_ids(&self, now_s: i64, limit: usize) -> Vec<String> {
        self.recents
            .lock()
            .map(|r| r.recent_play_ids(now_s, limit))
            .unwrap_or_default()
    }

    /// Cursor de leitura do journal do `lib_recent_plays` (ver `recents_seq`).
    pub fn recents_cursor(&self) -> i64 {
        self.recents_seq.load(Ordering::Relaxed)
    }

    /// Só avança: dois drains concorrentes (a UI chama em foco e em troca de
    /// faixa) não podem rebobinar o cursor.
    pub fn advance_recents_cursor(&self, seq: i64) {
        self.recents_seq.fetch_max(seq, Ordering::Relaxed);
    }

    pub fn wake(&self) {
        if let Ok(mut f) = self.wake_flag.lock() {
            *f = true;
        }
        self.wake_cv.notify_all();
    }

    /// Dorme até `dur` ou até alguém tocar o sino, o que vier primeiro.
    pub fn sleep(&self, dur: std::time::Duration) {
        let Ok(mut f) = self.wake_flag.lock() else { return };
        if !*f {
            if let Ok((g, _)) = self.wake_cv.wait_timeout(f, dur) {
                f = g;
            } else {
                return;
            }
        }
        *f = false;
    }
}

/// Grava `bytes` em `<path>.tmp` e troca por rename — no mesmo diretório o
/// rename(2) é atômico, então o leitor vê o arquivo antigo ou o novo, nunca
/// um meio-escrito.
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// A fila precisa de mais faixas?
///
/// Duas situações distintas: ela **já acabou** (`ended` — o player parou e só
/// volta se alguém anexar e retomar), ou está **secando** (tocando e a menos de
/// `slack` posições do fim). Fila parada por pausa não conta: o usuário pausou
/// de propósito e reabastecer seria trabalho invisível gastando bateria.
///
/// Com repeat ligado (`one` ou `all`) a resposta é sempre não: a fila nunca
/// seca num loop, e injetar autoplay por cima de um loop deliberado do usuário
/// seria o tender desfazendo uma escolha explícita.
pub fn needs_topup(
    status: &str,
    is_playing: bool,
    index: i32,
    count: i32,
    slack: i32,
    repeat_mode: &str,
) -> bool {
    if count <= 0 || repeat_mode != "off" {
        return false;
    }
    if status == "ended" {
        return true;
    }
    is_playing && index >= count - slack
}

/// Contexto de rodada — mesma convenção do `startRadioSession` do desktop, para
/// os eventos sincados serem agrupáveis dos dois lados.
pub fn context_for(mode: &Mode, epoch_ms: i64) -> Option<String> {
    match mode {
        Mode::Off => None,
        Mode::Radio { seed_track_id } => Some(format!("radio:{seed_track_id}:{epoch_ms}")),
        Mode::Station { station_id } => Some(format!("station:{station_id}:{epoch_ms}")),
    }
}

/// Largar a faixa cedo é rejeição; largar no fim é impaciência. Duração zero
/// (metadado ainda não resolvido) nunca conta — chutar rejeição por falta de
/// dado envenenaria o ranking com faixas que ninguém recusou.
pub fn is_early_skip(end_position_ms: i64, duration_ms: i64) -> bool {
    if duration_ms <= 0 || end_position_ms < 0 {
        return false;
    }
    (end_position_ms as f64 / duration_ms as f64) < SESSION_REJECT_RATIO
}

/// A escuta CONTA como play (shelf "Recently played")? Piso de 20s OU 25% da
/// faixa — o que vier primeiro. Sem duração (metadado não resolvido) só o
/// piso decide; posição negativa nunca conta. É outra régua da do
/// [`is_early_skip`] (rejeição de sessão): "contou como play" e "não foi
/// rejeição" são perguntas diferentes.
pub fn counts_as_play(end_position_ms: i64, duration_ms: i64) -> bool {
    if end_position_ms < 0 {
        return false;
    }
    if end_position_ms >= MIN_PLAY_MS {
        return true;
    }
    duration_ms > 0 && (end_position_ms as f64 / duration_ms as f64) >= MIN_PLAY_PCT
}

/// ÚNICO tradutor de linha do journal → item do anel de recentes, usado pelos
/// três feeders (tender, worker de sync e `lib_recent_plays`) para não haver
/// três leituras diferentes do mesmo evento. `None` = a linha não é escuta
/// (like/unlike entram no journal com o CMR-220 e NÃO podem virar "tocada")
/// ou o id não é u64. `at` = timestamp (fim da escuta, relógio do rádio);
/// `played_at` = início da escuta quando ela contou (paridade com o desktop,
/// que carimba no `record_play`), caindo no timestamp em linha sem
/// `started_at`.
pub fn recents_feed_item(
    event_type: &str,
    track_id: &str,
    started_at: i64,
    timestamp: i64,
    end_ms: i64,
    dur_ms: i64,
) -> Option<(u64, i64, Option<i64>)> {
    if event_type != "track_ended" && event_type != "track_skipped" {
        return None;
    }
    let id = track_id.parse::<u64>().ok()?;
    let played_at = counts_as_play(end_ms, dur_ms)
        .then(|| if started_at > 0 { started_at } else { timestamp });
    Some((id, timestamp, played_at))
}

/// Teto do ack do sync. O journal é lido por dois consumidores — o sync (que
/// envia e compacta) e o tender (que reage a skip) — e só um deles apaga. Sem
/// este teto o sync compactaria o journal antes de o tender ver o skip: em
/// cadência de 60s contra 20s, ~1 em cada 6 rejeições sumiria em silêncio.
/// Cursor parado há muito tempo = tender morto: o sync solta e segue.
pub fn ack_ceiling(sync_last_seq: i64, cursor: i64, cursor_at: i64, now_ms: i64) -> i64 {
    if cursor < 0 || cursor_at <= 0 || now_ms - cursor_at > CURSOR_STALE_MS {
        return sync_last_seq;
    }
    sync_last_seq.min(cursor)
}

/// A partir de qual índice a cauda pode ser descartada depois de uma rejeição.
///
/// Duas coisas são intocáveis: a faixa que está tocando e o que o usuário
/// enfileirou à mão. Como o serviço só remove SUFIXO, o corte começa depois do
/// último item que não é do motor — assim um "tocar em seguida" no meio da
/// cauda sobrevive à reação, ao custo de deixar viva a sugestão anterior a ele.
/// `None` = não há nada descartável.
pub fn truncate_from(origins: &[&str], index: i32, motor_origin: &str) -> Option<u32> {
    let first = (index + 1).max(0) as usize;
    if first >= origins.len() {
        return None;
    }
    let cut = origins
        .iter()
        .enumerate()
        .skip(first)
        .filter(|(_, o)| **o != motor_origin)
        .map(|(i, _)| i + 1)
        .last()
        .unwrap_or(first);
    if cut >= origins.len() {
        return None;
    }
    Some(cut as u32)
}

/// Origin com que as continuações são carimbadas. Station mantém `station`
/// (o sinal v3 já a conhece como origem passiva); qualquer outra fila
/// continuada pelo motor é `autoplay`, exatamente como no desktop.
pub fn origin_for(mode: &Mode) -> &'static str {
    match mode {
        Mode::Station { .. } => "station",
        _ => "autoplay",
    }
}

/// Thread que mantém a fila abastecida. Só existe no Android — no host o
/// módulo compila apenas para os testes das funções puras rodarem.
#[cfg(target_os = "android")]
pub(crate) mod tender {
    use super::*;
    use crate::mobile_library::Track;
    use std::time::Duration;
    use tauri::{Emitter, Manager};
    use tauri_plugin_rustify_audio::{AddMode, QueueItem, RustifyAudioExt};

    /// Cadência do ciclo. Curta o bastante para reagir antes de a fila secar
    /// (o slack de 2 faixas dá minutos de folga), longa o bastante para não
    /// pesar na bateria com o aparelho no bolso.
    const INTERVAL: Duration = Duration::from_secs(20);
    /// Teto por chamada ao plugin. Sem isto um IPC que nunca responde
    /// (Activity destruída no meio) penduraria a thread para sempre.
    const IPC_TIMEOUT: Duration = Duration::from_secs(8);

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// IPC do plugin com teto, SEM nunca dropar o future: o
    /// `run_mobile_plugin_async` do Tauri resolve a resposta com
    /// `send().unwrap()` num oneshot dentro do callback JNI (`extern "C"`) —
    /// se o receiver já morreu porque o future foi dropado sob timeout, o
    /// unwrap panica e o processo aborta. O future roda numa task própria
    /// do runtime (tokio) e o teto vale sobre o `JoinHandle`: dropá-lo não
    /// cancela a task, e a resposta tardia é descartada em silêncio.
    ///
    /// `op` recebe um clone do handle porque a task exige `'static`.
    fn call<R, T, Fut>(
        audio: &tauri_plugin_rustify_audio::RustifyAudio<R>,
        op: impl FnOnce(tauri_plugin_rustify_audio::RustifyAudio<R>) -> Fut,
    ) -> Result<T, String>
    where
        R: tauri::Runtime,
        T: Send + 'static,
        Fut: std::future::Future<Output = tauri_plugin_rustify_audio::Result<T>> + Send + 'static,
    {
        let task = tauri::async_runtime::spawn(op(audio.clone()));
        tauri::async_runtime::block_on(async {
            match tokio::time::timeout(IPC_TIMEOUT, task).await {
                Ok(Ok(r)) => r.map_err(|e| e.to_string()),
                Ok(Err(e)) => Err(format!("task do IPC do player: {e}")),
                Err(_) => Err("timeout no IPC do player".into()),
            }
        })
    }

    fn to_queue_item(t: &Track, origin: &str, context_id: Option<&str>) -> QueueItem {
        QueueItem {
            track_id: t.id.clone(),
            uri: format!("file://{}", t.path),
            title: t.title.clone(),
            artist: t.artist_name.clone().unwrap_or_default(),
            album: t.album_title.clone().unwrap_or_default(),
            artwork_uri: t.album_cover_path.as_ref().map(|p| format!("file://{p}")),
            duration_ms: t.duration_ms,
            // Origem POR ITEM: a continuação é do motor, mesmo que a faixa
            // corrente tenha entrado por outro caminho.
            origin: Some(origin.to_string()),
            context_id: context_id.map(|s| s.to_string()),
        }
    }

    pub(crate) fn spawn(app: tauri::AppHandle) {
        std::thread::Builder::new()
            .name("mobile-continuity".into())
            .spawn(move || loop {
                match app.try_state::<ContinuityState>() {
                    Some(state) => state.sleep(INTERVAL),
                    None => std::thread::sleep(INTERVAL),
                }
                if let Err(e) = tick(&app) {
                    tracing::debug!(%e, "continuity: ciclo sem efeito");
                    if let Some(state) = app.try_state::<ContinuityState>() {
                        if let Ok(mut c) = state.inner.lock() {
                            c.last_error = Some(e);
                        }
                    }
                }
            })
            .expect("spawn mobile-continuity");
    }

    /// Lê o journal a partir do cursor próprio e transforma skip cedo em
    /// negativo de sessão. Devolve `true` se houve rejeição neste ciclo.
    ///
    /// Leitura pura: quem apaga o journal é o worker de sync, que respeita
    /// este cursor ([`ack_ceiling`]). É por aqui que o skip feito no fone ou
    /// na notificação — com o WebView dormindo — chega ao motor.
    fn absorve_journal(app: &tauri::AppHandle, state: &ContinuityState) -> Result<bool, String> {
        let cursor = state
            .inner
            .lock()
            .map_err(|_| "lock envenenado")?
            .journal_cursor;
        let after = cursor.max(0);
        let drained = call(app.rustify_audio(), move |a| async move { a.drain_events(after).await })?;
        // Toda escuta do journal alimenta o anel de recentes, mesmo no
        // primeiro ciclo (recente é recente, de qualquer sessão). O helper
        // decide o que é escuta e o que contou como play (CMR-215).
        state.remember_recents(drained.events.iter().filter_map(|ev| {
            recents_feed_item(
                &ev.event_type,
                &ev.track_id,
                ev.started_at,
                ev.timestamp,
                ev.end_position_ms,
                ev.duration_ms,
            )
        }));
        // Primeiro ciclo da rodada: só posiciona o cursor. O que está no
        // journal aconteceu ANTES desta sessão — não é rejeição dela.
        if cursor == CURSOR_UNSET {
            let mut c = state.inner.lock().map_err(|_| "lock envenenado")?;
            c.journal_cursor = drained.last_seq;
            c.cursor_at = now_ms();
            return Ok(false);
        }
        let mut rejeitou = false;
        {
            let mut c = state.inner.lock().map_err(|_| "lock envenenado")?;
            for ev in &drained.events {
                // `backward` = voltou pra faixa anterior: repetir não é recusar.
                if ev.event_type != "track_skipped" || ev.backward {
                    continue;
                }
                if !is_early_skip(ev.end_position_ms, ev.duration_ms) {
                    continue;
                }
                if let Ok(id) = ev.track_id.parse::<u64>() {
                    c.note_negative(id);
                    rejeitou = true;
                }
            }
            c.journal_cursor = drained.last_seq;
            c.cursor_at = now_ms();
        }
        Ok(rejeitou)
    }

    fn tick(app: &tauri::AppHandle) -> Result<(), String> {
        let state = app
            .try_state::<ContinuityState>()
            .ok_or("sem ContinuityState")?;

        let (mode, context_id, seen) = {
            let c = state.inner.lock().map_err(|_| "lock envenenado")?;
            if !c.enabled || c.mode == Mode::Off {
                return Ok(());
            }
            (c.mode.clone(), c.context_id.clone(), c.seen.clone())
        };

        let audio = app.rustify_audio();
        let st = call(audio, |a| async move { a.get_state().await })?;
        let origin = origin_for(&mode);

        // Skips do journal (fone/notificação) + o que o app reportou na hora.
        let mut rejeitou = absorve_journal(app, &state)?;
        {
            let mut c = state.inner.lock().map_err(|_| "lock envenenado")?;
            rejeitou |= std::mem::take(&mut c.reaction_pending);
        }

        let mut queue = call(audio, |a| async move { a.get_queue().await })?;
        if rejeitou {
            let origins: Vec<&str> = queue.items.iter().map(|e| e.origin.as_str()).collect();
            if let Some(from) = truncate_from(&origins, queue.index, origin) {
                queue = call(audio, move |a| async move { a.truncate_queue(from).await })?;
                tracing::info!(from, "continuity: cauda descartada após rejeição");
            }
        }

        let count = queue.items.len() as i32;
        if !needs_topup(&st.status, st.is_playing, queue.index, count, SLACK, &st.repeat_mode) {
            return Ok(());
        }

        // Exclui o que já passou na rodada, o que está na fila agora E o que
        // tocou nos últimos dias (anel de recentes): sem isto a mesma faixa
        // volta a cada lote e o rádio de amanhã repete o de hoje.
        let mut exclude: Vec<String> = seen.iter().map(|id| id.to_string()).collect();
        exclude.extend(queue.items.iter().map(|e| e.track_id.clone()));
        exclude.extend(state.recent_ids());
        let negatives = {
            let c = state.inner.lock().map_err(|_| "lock envenenado")?;
            c.session_negatives.clone()
        };

        let seed = now_ms() as u64;
        let lib = app
            .try_state::<crate::Library>()
            .ok_or("sem Library")?;
        let batch: Vec<Track> = {
            let l = lib.0.lock().map_err(|_| "library lock")?;
            // Semeia pela faixa CORRENTE quando ela existe: o rádio acompanha
            // para onde a sessão andou, em vez de ficar preso na faixa que o
            // usuário escolheu dez faixas atrás.
            let seed_id = |fallback: u64| {
                st.track_id.clone().unwrap_or_else(|| fallback.to_string())
            };
            match &mode {
                Mode::Station { station_id } => {
                    let lote =
                        l.station_batch(station_id, &exclude, &negatives, STATION_BATCH, seed);
                    // Pool da station exaurido não pode virar silêncio: o rádio
                    // da faixa corrente assume e a música segue.
                    if lote.is_empty() {
                        l.radio_candidates(&seed_id(0), &exclude, &negatives, STATION_BATCH, seed).0
                    } else {
                        lote
                    }
                }
                Mode::Radio { seed_track_id } => {
                    l.radio_candidates(
                        &seed_id(*seed_track_id),
                        &exclude,
                        &negatives,
                        RADIO_BATCH,
                        seed,
                    )
                    .0
                }
                Mode::Off => Vec::new(),
            }
        };

        if batch.is_empty() {
            return Err("sem candidatos para o lote".into());
        }

        let items: Vec<QueueItem> = batch
            .iter()
            .map(|t| to_queue_item(t, origin, context_id.as_deref()))
            .collect();

        let req = tauri_plugin_rustify_audio::AddItemsRequest {
            items,
            origin: origin.to_string(),
            context_id: context_id.clone(),
            mode: AddMode::End,
            // A fila pode ter chegado ao fim antes deste ciclo: anexar sem
            // retomar deixaria o item novo parado depois do fim.
            resume_if_ended: true,
        };
        call(audio, move |a| async move { a.add_items(req).await })?;

        {
            let mut c = state.inner.lock().map_err(|_| "lock envenenado")?;
            c.remember(batch.iter().filter_map(|t| t.id.parse::<u64>().ok()));
            c.last_topup_at = now_ms();
            c.last_error = None;
        }

        // A UI redesenha a fila quando estiver acordada; se estiver dormindo,
        // o evento se perde e o syncQueue do resume cobre.
        let _ = app.emit(
            "rustify://queue-changed",
            serde_json::json!({ "reason": "topup", "added": batch.len() }),
        );
        tracing::info!(added = batch.len(), origin, "continuity: lote anexado");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fila_acabada_sempre_pede_lote() {
        // Mesmo pausado: `ended` significa que o player parou no fim e só
        // volta se alguém anexar. É o caso que faz a música morrer no bolso.
        assert!(needs_topup("ended", false, 9, 10, SLACK, "off"));
        assert!(needs_topup("ended", true, 9, 10, SLACK, "off"));
    }

    #[test]
    fn tocando_perto_do_fim_pede_lote() {
        // 10 itens, tocando o 9º (índice 8): resta 1 → dentro do slack de 2.
        assert!(needs_topup("ready", true, 8, 10, SLACK, "off"));
        assert!(needs_topup("ready", true, 9, 10, SLACK, "off"));
    }

    #[test]
    fn tocando_com_folga_nao_pede() {
        assert!(!needs_topup("ready", true, 3, 10, SLACK, "off"));
        assert!(!needs_topup("ready", true, 7, 10, SLACK, "off"));
    }

    #[test]
    fn pausado_no_meio_nao_pede() {
        // Pausa é decisão do usuário; reabastecer seria trabalho invisível
        // gastando bateria com o aparelho no bolso.
        assert!(!needs_topup("ready", false, 8, 10, SLACK, "off"));
    }

    #[test]
    fn fila_vazia_nunca_pede() {
        // Sem fila não há seed nem contexto — quem começa é o usuário.
        assert!(!needs_topup("ended", true, -1, 0, SLACK, "off"));
        assert!(!needs_topup("ready", true, -1, 0, SLACK, "off"));
    }

    #[test]
    fn repeat_ligado_nunca_pede_lote() {
        // repeat-all: o fim da fila volta pra primeira — nada seca.
        assert!(!needs_topup("ready", true, 9, 10, SLACK, "all"));
        // repeat-one: loop deliberado; injetar autoplay o desfaria.
        assert!(!needs_topup("ready", true, 9, 10, SLACK, "one"));
        // ate "ended" com repeat (transiente) fica quieto.
        assert!(!needs_topup("ended", true, 9, 10, SLACK, "all"));
    }

    #[test]
    fn contexto_espelha_a_convencao_do_desktop() {
        assert_eq!(
            context_for(&Mode::Radio { seed_track_id: 42 }, 1_700_000_000_000),
            Some("radio:42:1700000000000".into())
        );
        assert_eq!(
            context_for(&Mode::Station { station_id: "chill".into() }, 1_700_000_000_000),
            Some("station:chill:1700000000000".into())
        );
        assert_eq!(context_for(&Mode::Off, 1), None);
    }

    #[test]
    fn origin_de_station_nao_vira_autoplay() {
        // O sinal v3 desconta as duas como passivas, mas o corte por origin da
        // régua diária depende de elas continuarem distinguíveis.
        assert_eq!(origin_for(&Mode::Station { station_id: "x".into() }), "station");
        assert_eq!(origin_for(&Mode::Radio { seed_track_id: 1 }), "autoplay");
        assert_eq!(origin_for(&Mode::Off), "autoplay");
    }

    #[test]
    fn seen_nao_cresce_sem_limite() {
        let mut c = Continuity::default();
        c.remember(0..(SEEN_CAP as u64 + 50));
        assert_eq!(c.seen.len(), SEEN_CAP);
        // manteve as mais RECENTES (as antigas saem primeiro)
        assert_eq!(*c.seen.last().unwrap(), SEEN_CAP as u64 + 49);
    }

    #[test]
    fn seen_ignora_repetido() {
        let mut c = Continuity::default();
        c.remember([1, 2, 3]);
        c.remember([2, 3, 4]);
        assert_eq!(c.seen, vec![1, 2, 3, 4]);
    }

    #[test]
    fn skip_cedo_nos_limites() {
        // 34% = rejeição; 35% (o limiar) já não é.
        assert!(is_early_skip(34, 100));
        assert!(!is_early_skip(35, 100));
        assert!(!is_early_skip(99, 100));
        // Sem duração não há fração: chutar rejeição envenenaria o ranking.
        assert!(!is_early_skip(10, 0));
        assert!(!is_early_skip(-1, 100));
    }

    #[test]
    fn negativos_de_sessao_cabem_no_teto_e_o_mais_fresco_lidera() {
        let mut c = Continuity::default();
        for id in 1..=(SESSION_NEG_CAP as u64 + 5) {
            c.note_negative(id);
        }
        assert_eq!(c.session_negatives.len(), SESSION_NEG_CAP);
        assert_eq!(c.session_negatives[0], SESSION_NEG_CAP as u64 + 5);
        // o mais antigo caiu
        assert!(!c.session_negatives.contains(&1));
    }

    #[test]
    fn negativo_repetido_sobe_sem_duplicar() {
        let mut c = Continuity::default();
        c.note_negative(7);
        c.note_negative(8);
        c.note_negative(7);
        assert_eq!(c.session_negatives, vec![7, 8]);
    }

    #[test]
    fn ack_do_sync_espera_o_cursor_do_tender() {
        // tender leu até 10, sync tem 25 gravados → só pode apagar até 10.
        assert_eq!(ack_ceiling(25, 10, 1_000, 1_500), 10);
        // tender à frente do lote deste ciclo: o teto é o próprio lote.
        assert_eq!(ack_ceiling(25, 40, 1_000, 1_500), 25);
    }

    #[test]
    fn cursor_morto_nao_segura_o_journal_para_sempre() {
        // Sem cursor ainda (continuidade nunca armada) e cursor velho: solta.
        assert_eq!(ack_ceiling(25, 0, 0, 999_999), 25);
        // Cursor ainda não posicionado nunca deve virar teto (ackaria nada).
        assert_eq!(ack_ceiling(25, CURSOR_UNSET, 1_000, 1_500), 25);
        assert_eq!(ack_ceiling(25, 10, 1_000, 1_000 + CURSOR_STALE_MS + 1), 25);
        // No limite ainda espera.
        assert_eq!(ack_ceiling(25, 10, 1_000, 1_000 + CURSOR_STALE_MS), 10);
    }

    #[test]
    fn corte_da_cauda_preserva_corrente_e_escolha_do_usuario() {
        let q = ["autoplay", "autoplay", "autoplay", "autoplay"];
        // tocando o índice 1 → corta a partir do 2, nunca o 1.
        assert_eq!(truncate_from(&q, 1, "autoplay"), Some(2));
        // nada depois da corrente: não há o que cortar.
        assert_eq!(truncate_from(&q, 3, "autoplay"), None);
        // fila só de escolhas do usuário: intocável.
        let manual = ["manual", "manual", "manual"];
        assert_eq!(truncate_from(&manual, 0, "autoplay"), None);
    }

    #[test]
    fn tocar_em_seguida_sobrevive_a_reacao() {
        // O usuário mandou tocar "manual" depois da corrente: o corte começa
        // depois dele, mesmo que isso deixe viva a sugestão que o precede.
        let q = ["autoplay", "autoplay", "manual", "autoplay", "autoplay"];
        assert_eq!(truncate_from(&q, 0, "autoplay"), Some(3));
        // Se o manual é o último, não sobra sugestão para descartar.
        let q2 = ["autoplay", "autoplay", "manual"];
        assert_eq!(truncate_from(&q2, 0, "autoplay"), None);
    }

    #[test]
    fn recents_expira_por_ttl_e_respeita_o_cap() {
        let mut r = RecentsRing::default();
        let now = 1_000_000_000_i64;
        r.push(1, now - RECENTS_TTL_S - 1, None); // velho de mais de 7 dias
        r.push(2, now - 60, None);
        r.prune(now);
        assert_eq!(r.ids(), vec!["2"]);
        // cap: a 301a expulsa a mais antiga
        let mut r = RecentsRing::default();
        for id in 0..(RECENTS_CAP as u64 + 1) {
            r.push(id, now, None);
        }
        assert_eq!(r.len(), RECENTS_CAP);
        assert!(!r.ids().contains(&"0".to_string()));
    }

    #[test]
    fn recents_repetido_renova_o_relogio_sem_duplicar() {
        let mut r = RecentsRing::default();
        r.push(7, 100, None);
        r.push(8, 200, None);
        r.push(7, 300, None);
        assert_eq!(r.ids(), vec!["8", "7"]);
    }

    #[test]
    fn recents_sobrevive_ao_round_trip_de_json() {
        let mut r = RecentsRing::default();
        r.push(18_400_000_000_000_000_001, 500, None); // > 2^53: só sobrevive como string
        let volta = RecentsRing::from_json(&r.to_json());
        assert_eq!(volta.ids(), vec!["18400000000000000001"]);
        // lixo no disco não derruba o boot
        assert_eq!(RecentsRing::from_json(b"nao e json").len(), 0);
    }

    #[test]
    fn corte_com_indice_invalido_nao_estoura() {
        // index -1 = fila que ainda não adotou nada.
        assert_eq!(truncate_from(&["autoplay"], -1, "autoplay"), Some(0));
        assert_eq!(truncate_from(&[], -1, "autoplay"), None);
        assert_eq!(truncate_from(&["autoplay"], 9, "autoplay"), None);
    }

    // ── Recently played (CMR-215) ────────────────────────────────────────────

    #[test]
    fn counts_as_play_nos_limites() {
        // Piso de 20s: 19_999 não conta, 20_000 conta — mesmo sem duração.
        assert!(!counts_as_play(19_999, 0));
        assert!(counts_as_play(20_000, 0));
        assert!(counts_as_play(MIN_PLAY_MS, 0));
        // Skip aos 3s de uma faixa de 200s: nem piso nem fração.
        assert!(!counts_as_play(3_000, 200_000));
        // Skit de 25s: conta pelo piso mesmo sendo 12,5% da faixa.
        assert!(counts_as_play(25_000, 200_000));
        // Fração: faixa curta de 40s ouvida até 10s = 25% conta; 9_999 não.
        assert!(counts_as_play(10_000, 40_000));
        assert!(!counts_as_play(9_999, 40_000));
        // Posição negativa nunca conta, mesmo com duração inválida.
        assert!(!counts_as_play(-1, 100_000));
        assert!(!counts_as_play(-1, 0));
    }

    #[test]
    fn recent_plays_lista_so_o_que_contou_do_mais_recente() {
        let mut r = RecentsRing::default();
        r.push(1, 100, Some(100));
        r.push(2, 200, None);
        r.push(3, 300, Some(300));
        // A shelf só vê o que CONTOU, mais recente primeiro...
        assert_eq!(r.recent_play_ids(300, 8), vec!["3", "1"]);
        // ...e o rádio continua vendo tudo que tocou (contrato intocado).
        assert_eq!(r.ids(), vec!["1", "2", "3"]);
    }

    #[test]
    fn skip_cedo_nao_apaga_o_play_anterior() {
        // Sticky: a faixa contou ontem; o skip de hoje renova o relógio do
        // rádio (`at`) mas não apaga o play que contou.
        let mut r = RecentsRing::default();
        assert!(r.push(1, 100, Some(100)));
        assert!(r.push(1, 200, None));
        assert_eq!(r.ids(), vec!["1"]);
        assert_eq!(r.ids[0].at, 200);
        assert_eq!(r.ids[0].played_at, Some(100));
        assert_eq!(r.recent_play_ids(200, 8), vec!["1"]);
    }

    #[test]
    fn recent_plays_respeita_limit_e_ttl() {
        let now = 1_000_000_000_i64;
        let mut r = RecentsRing::default();
        // Fora do TTL pelo played_at: não entra na shelf.
        r.push(1, now - RECENTS_TTL_S - 10, Some(now - RECENTS_TTL_S - 10));
        r.push(2, now - 300, Some(now - 300));
        r.push(3, now - 200, Some(now - 200));
        r.push(4, now - 100, Some(now - 100));
        assert_eq!(r.recent_play_ids(now, 8), vec!["4", "3", "2"]);
        assert_eq!(r.recent_play_ids(now, 2), vec!["4", "3"]);
        assert_eq!(r.recent_play_ids(now, 0), Vec::<String>::new());
    }

    #[test]
    fn recents_legado_sem_played_at_fica_no_radio_e_fora_da_shelf() {
        // Arquivo gravado antes do CMR-215: só {id, at}. Continua válido
        // pro exclude do rádio e NÃO aparece como "tocada" na shelf.
        let r = RecentsRing::from_json(br#"{"ids":[{"id":"5","at":100},{"id":"6","at":150}]}"#);
        assert_eq!(r.ids(), vec!["5", "6"]);
        assert_eq!(r.recent_play_ids(150, 8), Vec::<String>::new());
    }

    #[test]
    fn recents_round_trip_preserva_played_at() {
        let mut r = RecentsRing::default();
        r.push(18_400_000_000_000_000_001, 500, Some(450));
        r.push(7, 600, None);
        let volta = RecentsRing::from_json(&r.to_json());
        assert_eq!(volta.ids(), vec!["18400000000000000001", "7"]);
        assert_eq!(volta.ids[0].played_at, Some(450));
        assert_eq!(volta.ids[1].played_at, None);
        assert_eq!(volta.recent_play_ids(600, 8), vec!["18400000000000000001"]);
    }

    #[test]
    fn push_devolve_false_quando_nada_muda() {
        let mut r = RecentsRing::default();
        assert!(r.push(1, 100, Some(100)));
        // Mesmo evento de novo (dois feeders leem o mesmo journal): nada muda.
        assert!(!r.push(1, 100, Some(100)));
        // Sem played_at e sem relógio novo: nada muda.
        assert!(!r.push(1, 100, None));
        // Relógio renovado: mudou (o arquivo precisa ser reescrito).
        assert!(r.push(1, 150, None));
        // Play que conta numa faixa que só tinha skip: mudou.
        assert!(r.push(2, 200, None));
        assert!(r.push(2, 200, Some(180)));
        assert!(!r.push(2, 200, Some(180)));
    }

    #[test]
    fn push_devolve_true_quando_prune_removeu() {
        // Anel carregado do disco (from_json não poda) com uma entrada já
        // expirada. O feeder repete um evento que NÃO muda a entrada viva —
        // mas a poda tirou a expirada, e o arquivo precisa refletir isso.
        let now = 1_000_000_000_i64;
        let velho = now - RECENTS_TTL_S - 1;
        let json = format!(
            r#"{{"ids":[{{"id":"1","at":{velho}}},{{"id":"2","at":{now},"played_at":{now}}}]}}"#
        );
        let mut r = RecentsRing::from_json(json.as_bytes());
        assert_eq!(r.len(), 2);
        assert!(r.push(2, now, Some(now)));
        assert_eq!(r.ids(), vec!["2"]);
        // Sem nada a podar e sem mudança na entrada: agora é false.
        assert!(!r.push(2, now, Some(now)));
    }

    #[test]
    fn entrada_sem_mudanca_nao_e_movida() {
        // O anel é ordenado por `at` (o cap expulsa pela frente): só uma
        // escuta mais NOVA move a entrada pro fim. Re-drain de evento velho
        // (sync re-lê do zero) e play que só completa o `played_at` ficam
        // onde estão.
        let mut r = RecentsRing::default();
        r.push(1, 100, None);
        r.push(2, 200, None);
        assert!(!r.push(1, 100, None));
        assert_eq!(r.ids(), vec!["1", "2"]);
        // `at` igual, played_at novo: muda (true) mas em lugar.
        assert!(r.push(1, 100, Some(90)));
        assert_eq!(r.ids(), vec!["1", "2"]);
        assert_eq!(r.ids[0].played_at, Some(90));
        // Evento mais velho que o relógio da entrada: nem move nem regride.
        assert!(!r.push(2, 150, None));
        assert_eq!(r.ids(), vec!["1", "2"]);
        assert_eq!(r.ids[1].at, 200);
        // Escuta mais nova: aí sim vai pro fim.
        assert!(r.push(1, 300, None));
        assert_eq!(r.ids(), vec!["2", "1"]);
    }

    #[test]
    fn recents_feed_item_marca_played_at_pelo_started_at_quando_conta() {
        // Faixa ouvida inteira: at = fim da escuta, played_at = INÍCIO.
        assert_eq!(
            recents_feed_item("track_ended", "42", 1_000, 1_200, 200_000, 200_000),
            Some((42, 1_200, Some(1_000)))
        );
        // Sem started_at (linha antiga / zero): cai no timestamp.
        assert_eq!(
            recents_feed_item("track_ended", "42", 0, 1_200, 200_000, 200_000),
            Some((42, 1_200, Some(1_200)))
        );
        // Skip tardio (aos 60s de 200s) também conta como play.
        assert_eq!(
            recents_feed_item("track_skipped", "42", 1_000, 1_060, 60_000, 200_000),
            Some((42, 1_060, Some(1_000)))
        );
    }

    #[test]
    fn recents_feed_item_skip_cedo_entra_no_radio_sem_played_at() {
        assert_eq!(
            recents_feed_item("track_skipped", "42", 1_000, 1_003, 3_000, 200_000),
            Some((42, 1_003, None))
        );
    }

    #[test]
    fn recents_feed_item_ignora_like_e_unlike() {
        // Linhas de like/unlike vão entrar no journal (CMR-220) e NÃO são
        // escuta: nem o rádio nem a shelf podem tratá-las como "tocada".
        assert_eq!(recents_feed_item("like", "42", 1_000, 1_200, 200_000, 200_000), None);
        assert_eq!(recents_feed_item("unlike", "42", 1_000, 1_200, 200_000, 200_000), None);
        assert_eq!(recents_feed_item("", "42", 1_000, 1_200, 200_000, 200_000), None);
    }

    #[test]
    fn recents_feed_item_id_nao_u64_vira_none() {
        assert_eq!(recents_feed_item("track_ended", "abc", 1_000, 1_200, 200_000, 200_000), None);
        assert_eq!(recents_feed_item("track_ended", "-1", 1_000, 1_200, 200_000, 200_000), None);
        assert_eq!(recents_feed_item("track_ended", "", 1_000, 1_200, 200_000, 200_000), None);
    }
}
