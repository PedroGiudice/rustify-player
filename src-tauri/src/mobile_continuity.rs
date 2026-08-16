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
use std::sync::Mutex;

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
}

#[derive(Debug, Default)]
pub struct ContinuityState(pub Mutex<Continuity>);

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
                std::thread::sleep(INTERVAL);
                if let Err(e) = tick(&app) {
                    tracing::debug!(%e, "continuity: ciclo sem efeito");
                    if let Some(state) = app.try_state::<ContinuityState>() {
                        if let Ok(mut c) = state.0.lock() {
                            c.last_error = Some(e);
                        }
                    }
                }
            })
            .expect("spawn mobile-continuity");
    }

    fn tick(app: &tauri::AppHandle) -> Result<(), String> {
        let state = app
            .try_state::<ContinuityState>()
            .ok_or("sem ContinuityState")?;

        let (mode, context_id, seen) = {
            let c = state.0.lock().map_err(|_| "lock envenenado")?;
            if !c.enabled || c.mode == Mode::Off {
                return Ok(());
            }
            (c.mode.clone(), c.context_id.clone(), c.seen.clone())
        };

        let audio = app.rustify_audio();
        let st = call(audio.get_state())?;
        if !needs_topup(&st.status, st.is_playing, st.index, st.count, SLACK) {
            return Ok(());
        }

        // Exclui o que já passou na rodada E o que está na fila agora: sem
        // isto a mesma faixa volta a cada lote e o rádio parece quebrado.
        let queue = call(audio.get_queue())?;
        let mut exclude: Vec<String> = seen.iter().map(|id| id.to_string()).collect();
        exclude.extend(queue.items.iter().map(|e| e.track_id.clone()));

        let seed = now_ms() as u64;
        let lib = app
            .try_state::<crate::Library>()
            .ok_or("sem Library")?;
        let batch: Vec<Track> = {
            let l = lib.0.lock().map_err(|_| "library lock")?;
            match &mode {
                Mode::Station { station_id } => {
                    l.station_batch(station_id, &exclude, STATION_BATCH, seed)
                }
                Mode::Radio { seed_track_id } => {
                    // Semeia pela faixa CORRENTE quando ela existe: o rádio
                    // acompanha para onde a sessão andou, em vez de ficar preso
                    // na faixa que o usuário escolheu dez faixas atrás.
                    let seed_id = st
                        .track_id
                        .clone()
                        .unwrap_or_else(|| seed_track_id.to_string());
                    l.radio_batch(&seed_id, &exclude, RADIO_BATCH, seed)
                }
                Mode::Off => Vec::new(),
            }
        };

        if batch.is_empty() {
            return Err("sem candidatos para o lote".into());
        }

        let origin = origin_for(&mode);
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
            let mut c = state.0.lock().map_err(|_| "lock envenenado")?;
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
}
