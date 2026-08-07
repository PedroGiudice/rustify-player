//! testing.rs — `FakeSlskd`, impl roteirizada de [`crate::SlskdApi`] para
//! testes sem rede. `pub` de propósito: reusado na Etapa C
//! (`src-tauri/src/slsk/`) para testar coordinator/board sem um slskd
//! real de pé. `Mutex` (não `RefCell`) porque `SlskdApi: Send + Sync` —
//! o trait vive atrás de `Arc<dyn SlskdApi>` no estado do app.

use std::collections::VecDeque;
use std::sync::Mutex;

use crate::error::SlskdError;
use crate::wire::{ApiSearch, ApiSearchResponse, ApiTransferUser, ServerStatus};
use crate::SlskdApi;

/// Cada método consome a próxima resposta enfileirada em seu `_script`;
/// fila vazia devolve um `Ok` neutro (evita que testes que não roteirizam
/// um método específico precisem fazer setup irrelevante). `delete_search`
/// e `enqueue` também registram os argumentos recebidos em `*_calls` para
/// assert de chamada (ex.: `SearchGuard` deletando a busca certa).
#[derive(Default)]
pub struct FakeSlskd {
    pub status_script: Mutex<VecDeque<Result<ServerStatus, SlskdError>>>,
    pub start_search_script: Mutex<VecDeque<Result<String, SlskdError>>>,
    pub search_state_script: Mutex<VecDeque<Result<ApiSearch, SlskdError>>>,
    pub search_responses_script: Mutex<VecDeque<Result<Vec<ApiSearchResponse>, SlskdError>>>,
    pub delete_search_script: Mutex<VecDeque<Result<(), SlskdError>>>,
    pub delete_search_calls: Mutex<Vec<String>>,
    pub list_searches_script: Mutex<VecDeque<Result<Vec<ApiSearch>, SlskdError>>>,
    pub enqueue_script: Mutex<VecDeque<Result<(), SlskdError>>>,
    pub enqueue_calls: Mutex<Vec<(String, String, u64)>>,
    pub downloads_script: Mutex<VecDeque<Result<Vec<ApiTransferUser>, SlskdError>>>,
    pub cancel_download_script: Mutex<VecDeque<Result<(), SlskdError>>>,
}

impl FakeSlskd {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_status(&self, result: Result<ServerStatus, SlskdError>) {
        self.status_script.lock().unwrap().push_back(result);
    }

    pub fn push_delete_search(&self, result: Result<(), SlskdError>) {
        self.delete_search_script.lock().unwrap().push_back(result);
    }

    pub fn push_enqueue(&self, result: Result<(), SlskdError>) {
        self.enqueue_script.lock().unwrap().push_back(result);
    }
}

impl SlskdApi for FakeSlskd {
    fn status(&self) -> Result<ServerStatus, SlskdError> {
        self.status_script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(ServerStatus::default()))
    }

    fn start_search(&self, _text: &str) -> Result<String, SlskdError> {
        self.start_search_script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok("fake-search-id".to_string()))
    }

    fn search_state(&self, _id: &str) -> Result<ApiSearch, SlskdError> {
        self.search_state_script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(ApiSearch::default()))
    }

    fn search_responses(&self, _id: &str) -> Result<Vec<ApiSearchResponse>, SlskdError> {
        self.search_responses_script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    fn delete_search(&self, id: &str) -> Result<(), SlskdError> {
        self.delete_search_calls.lock().unwrap().push(id.to_string());
        self.delete_search_script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    fn list_searches(&self) -> Result<Vec<ApiSearch>, SlskdError> {
        self.list_searches_script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    fn enqueue(&self, username: &str, filename: &str, size: u64) -> Result<(), SlskdError> {
        self.enqueue_calls
            .lock()
            .unwrap()
            .push((username.to_string(), filename.to_string(), size));
        self.enqueue_script.lock().unwrap().pop_front().unwrap_or(Ok(()))
    }

    fn downloads(&self) -> Result<Vec<ApiTransferUser>, SlskdError> {
        self.downloads_script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(Vec::new()))
    }

    fn cancel_download(&self, _username: &str, _id: &str) -> Result<(), SlskdError> {
        self.cancel_download_script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()))
    }
}
