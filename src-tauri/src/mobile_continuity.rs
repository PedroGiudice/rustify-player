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

/// Estado compartilhado + o sino que acorda o tender. Sem o sino, um skip
/// feito dentro do app esperaria o ciclo inteiro (20s) para virar reação — o
/// usuário veria a fila velha e concluiria que não fez nada.
#[derive(Debug, Default)]
pub struct ContinuityState {
    pub inner: Mutex<Continuity>,
    wake_flag: Mutex<bool>,
    wake_cv: Condvar,
}

impl ContinuityState {
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

/// A fila precisa de mais faixas?
///
/// Duas situações distintas: ela **já acabou** (`ended` — o player parou e só
/// volta se alguém anexar e retomar), ou está **secando** (tocando e a menos de
/// `slack` posições do fim). Fila parada por pausa não conta: o usuário pausou
/// de propósito e reabastecer seria trabalho invisível gastando bateria.
pub fn needs_topup(status: &str, is_playing: bool, index: i32, count: i32, slack: i32) -> bool {
    if count <= 0 {
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

    /// `block_on` com teto — o `run_mobile_plugin_async` não tem timeout
    /// próprio e o runtime do Tauri é tokio.
    fn call<T>(fut: impl std::future::Future<Output = tauri_plugin_rustify_audio::Result<T>>) -> Result<T, String> {
        tauri::async_runtime::block_on(async {
            match tokio::time::timeout(IPC_TIMEOUT, fut).await {
                Ok(r) => r.map_err(|e| e.to_string()),
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
        let drained = call(app.rustify_audio().drain_events(cursor.max(0)))?;
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
        let st = call(audio.get_state())?;
        let origin = origin_for(&mode);

        // Skips do journal (fone/notificação) + o que o app reportou na hora.
        let mut rejeitou = absorve_journal(app, &state)?;
        {
            let mut c = state.inner.lock().map_err(|_| "lock envenenado")?;
            rejeitou |= std::mem::take(&mut c.reaction_pending);
        }

        let mut queue = call(audio.get_queue())?;
        if rejeitou {
            let origins: Vec<&str> = queue.items.iter().map(|e| e.origin.as_str()).collect();
            if let Some(from) = truncate_from(&origins, queue.index, origin) {
                queue = call(audio.truncate_queue(from))?;
                tracing::info!(from, "continuity: cauda descartada após rejeição");
            }
        }

        let count = queue.items.len() as i32;
        if !needs_topup(&st.status, st.is_playing, queue.index, count, SLACK) {
            return Ok(());
        }

        // Exclui o que já passou na rodada E o que está na fila agora: sem
        // isto a mesma faixa volta a cada lote e o rádio parece quebrado.
        let mut exclude: Vec<String> = seen.iter().map(|id| id.to_string()).collect();
        exclude.extend(queue.items.iter().map(|e| e.track_id.clone()));
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

        call(audio.add_items(tauri_plugin_rustify_audio::AddItemsRequest {
            items,
            origin: origin.to_string(),
            context_id: context_id.clone(),
            mode: AddMode::End,
            // A fila pode ter chegado ao fim antes deste ciclo: anexar sem
            // retomar deixaria o item novo parado depois do fim.
            resume_if_ended: true,
        }))?;

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
        assert!(needs_topup("ended", false, 9, 10, SLACK));
        assert!(needs_topup("ended", true, 9, 10, SLACK));
    }

    #[test]
    fn tocando_perto_do_fim_pede_lote() {
        // 10 itens, tocando o 9º (índice 8): resta 1 → dentro do slack de 2.
        assert!(needs_topup("ready", true, 8, 10, SLACK));
        assert!(needs_topup("ready", true, 9, 10, SLACK));
    }

    #[test]
    fn tocando_com_folga_nao_pede() {
        assert!(!needs_topup("ready", true, 3, 10, SLACK));
        assert!(!needs_topup("ready", true, 7, 10, SLACK));
    }

    #[test]
    fn pausado_no_meio_nao_pede() {
        // Pausa é decisão do usuário; reabastecer seria trabalho invisível
        // gastando bateria com o aparelho no bolso.
        assert!(!needs_topup("ready", false, 8, 10, SLACK));
    }

    #[test]
    fn fila_vazia_nunca_pede() {
        // Sem fila não há seed nem contexto — quem começa é o usuário.
        assert!(!needs_topup("ended", true, -1, 0, SLACK));
        assert!(!needs_topup("ready", true, -1, 0, SLACK));
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
    fn corte_com_indice_invalido_nao_estoura() {
        // index -1 = fila que ainda não adotou nada.
        assert_eq!(truncate_from(&["autoplay"], -1, "autoplay"), Some(0));
        assert_eq!(truncate_from(&[], -1, "autoplay"), None);
        assert_eq!(truncate_from(&["autoplay"], 9, "autoplay"), None);
    }
}
