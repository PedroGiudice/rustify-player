//! Cliente Rust puro para a API do slskd (Soulseek daemon).
//!
//! Protocolo, ranking, pacing e destino de staging — 100% testável offline
//! contra fixtures reais. Sem dependência de Tauri ou Qdrant; a política
//! (coordinator, board, staging no disco) mora em `src-tauri/src/slsk/`.

pub mod auth;
pub mod error;
pub mod pacing;
pub mod rank;
pub mod stage_plan;
pub mod testing;
pub mod wire;

use std::sync::RwLock;

pub use auth::SlskAuth;
pub use error::SlskdError;
use wire::{ApiSearch, ApiSearchResponse, ApiTransferUser, ServerStatus};

/// Superfície mínima contra a API do slskd. `Send + Sync` porque vive
/// atrás de `Arc<dyn SlskdApi>` no estado do app (Etapa C).
pub trait SlskdApi: Send + Sync {
    fn status(&self) -> Result<ServerStatus, SlskdError>;
    fn start_search(&self, text: &str) -> Result<String, SlskdError>;
    fn search_state(&self, id: &str) -> Result<ApiSearch, SlskdError>;
    fn search_responses(&self, id: &str) -> Result<Vec<ApiSearchResponse>, SlskdError>;
    fn delete_search(&self, id: &str) -> Result<(), SlskdError>;
    fn list_searches(&self) -> Result<Vec<ApiSearch>, SlskdError>;
    fn enqueue(&self, username: &str, filename: &str, size: u64) -> Result<(), SlskdError>;
    fn downloads(&self) -> Result<Vec<ApiTransferUser>, SlskdError>;
    fn cancel_download(&self, username: &str, id: &str) -> Result<(), SlskdError>;
}

/// Chama `f`; em `Unauthorized`, tenta de novo UMA vez (single-shot). Se o
/// retry também vier `Unauthorized`, propaga. Não é específico de HTTP —
/// `HttpSlskd` usa isto envolvendo uma chamada que, ao ver o token
/// zerado (limpo no primeiro 401), re-loga antes de tentar de novo.
pub fn call_with_relogin<T>(mut f: impl FnMut() -> Result<T, SlskdError>) -> Result<T, SlskdError> {
    match f() {
        Err(SlskdError::Unauthorized) => f(),
        other => other,
    }
}

/// Mapeia status HTTP não-2xx para `SlskdError`. 401 e 409 têm tratamento
/// dedicado no app (re-login / sweep de searches); o resto vira `Http`.
fn error_for_status(status: u16) -> SlskdError {
    match status {
        401 => SlskdError::Unauthorized,
        409 => SlskdError::Conflict409,
        other => SlskdError::Http(other),
    }
}

/// RAII: `Drop` chama `delete_search`, ignorando erro — garante que uma
/// busca é deletada mesmo em caminho de erro (spec §6.3, mata o 409 na
/// raiz). Mesmo padrão de `ScanGuard` (`pipeline.rs:274`).
pub struct SearchGuard<'a>(pub &'a dyn SlskdApi, pub String);

impl Drop for SearchGuard<'_> {
    fn drop(&mut self) {
        let _ = self.0.delete_search(&self.1);
    }
}

/// Implementação real contra um slskd de verdade (`ureq`, bloqueante —
/// nunca chamado de dentro de um `#[tauri::command]`, só da thread
/// `slsk-coord` na Etapa C). Coberta por tipos + fixtures do spike; sem
/// servidor HTTP fake no v1 (spec §Testes).
pub struct HttpSlskd {
    base_url: String,
    auth: SlskAuth,
    token: RwLock<Option<String>>,
    agent: ureq::Agent,
}

impl HttpSlskd {
    pub fn new(base_url: String, auth: SlskAuth) -> Self {
        Self {
            base_url,
            auth,
            token: RwLock::new(None),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(10))
                .build(),
        }
    }

    /// Token corrente. `ApiKey` nunca expira (sem sessão); `Password`
    /// re-loga se o cache estiver vazio (limpo em 401 por `execute`).
    fn ensure_token(&self) -> Result<String, SlskdError> {
        if let SlskAuth::ApiKey(key) = &self.auth {
            return Ok(key.clone());
        }
        if let Some(token) = self.token.read().unwrap().clone() {
            return Ok(token);
        }
        self.login()
    }

    fn login(&self) -> Result<String, SlskdError> {
        let SlskAuth::Password { user, pass } = &self.auth else {
            unreachable!("ApiKey auth nunca chama login — ensure_token devolve a key direto")
        };
        let url = format!("{}/api/v0/session", self.base_url);
        let resp = self
            .agent
            .post(&url)
            .send_json(ureq::json!({ "username": user, "password": pass }))
            .map_err(map_ureq_error)?;
        let body: serde_json::Value = resp
            .into_json()
            .map_err(|e| SlskdError::Parse(e.to_string()))?;
        let token = body
            .get("token")
            .and_then(|t| t.as_str())
            .ok_or_else(|| SlskdError::Parse("resposta de /session sem campo token".to_string()))?
            .to_string();
        *self.token.write().unwrap() = Some(token.clone());
        Ok(token)
    }

    fn auth_header(&self, token: &str) -> (&'static str, String) {
        match self.auth {
            SlskAuth::ApiKey(_) => ("X-API-Key", token.to_string()),
            SlskAuth::Password { .. } => ("Authorization", format!("Bearer {token}")),
        }
    }

    /// Envia a requisição uma vez. Em 401, limpa o token cacheado (auth
    /// por senha) para que o próximo `ensure_token`, chamado pelo retry
    /// de `call_with_relogin`, force um `login()` novo.
    fn execute(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<ureq::Response, SlskdError> {
        let token = self.ensure_token()?;
        let (header, value) = self.auth_header(&token);
        let url = format!("{}{path}", self.base_url);
        let req = self.agent.request(method, &url).set(header, &value);
        let sent = match body {
            Some(b) => req.send_json(b.clone()),
            None => req.call(),
        };
        match sent {
            Ok(resp) => Ok(resp),
            Err(ureq::Error::Status(401, _)) => {
                if !matches!(self.auth, SlskAuth::ApiKey(_)) {
                    *self.token.write().unwrap() = None;
                }
                Err(SlskdError::Unauthorized)
            }
            Err(ureq::Error::Status(code, _)) => Err(error_for_status(code)),
            Err(transport @ ureq::Error::Transport(_)) => Err(map_ureq_error(transport)),
        }
    }

    fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, SlskdError> {
        call_with_relogin(|| {
            self.execute(method, path, body.as_ref())
                .and_then(|resp| resp.into_json::<T>().map_err(|e| SlskdError::Parse(e.to_string())))
        })
    }

    fn request_no_content(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<(), SlskdError> {
        call_with_relogin(|| self.execute(method, path, body.as_ref()).map(|_| ()))
    }
}

fn map_ureq_error(err: ureq::Error) -> SlskdError {
    match err {
        ureq::Error::Status(code, _) => error_for_status(code),
        ureq::Error::Transport(t) => SlskdError::Network(t.to_string()),
    }
}

impl SlskdApi for HttpSlskd {
    fn status(&self) -> Result<ServerStatus, SlskdError> {
        self.request("GET", "/api/v0/server", None)
    }

    fn start_search(&self, text: &str) -> Result<String, SlskdError> {
        #[derive(serde::Deserialize)]
        struct StartSearchResponse {
            id: String,
        }
        let body = serde_json::json!({
            "searchText": text,
            "fileLimit": 10_000,
            "filterResponses": true,
        });
        let resp: StartSearchResponse = self.request("POST", "/api/v0/searches", Some(body))?;
        Ok(resp.id)
    }

    fn search_state(&self, id: &str) -> Result<ApiSearch, SlskdError> {
        self.request("GET", &format!("/api/v0/searches/{id}"), None)
    }

    fn search_responses(&self, id: &str) -> Result<Vec<ApiSearchResponse>, SlskdError> {
        self.request("GET", &format!("/api/v0/searches/{id}/responses"), None)
    }

    fn delete_search(&self, id: &str) -> Result<(), SlskdError> {
        self.request_no_content("DELETE", &format!("/api/v0/searches/{id}"), None)
    }

    fn list_searches(&self) -> Result<Vec<ApiSearch>, SlskdError> {
        self.request("GET", "/api/v0/searches", None)
    }

    fn enqueue(&self, username: &str, filename: &str, size: u64) -> Result<(), SlskdError> {
        let body = serde_json::json!([{ "filename": filename, "size": size }]);
        self.request_no_content(
            "POST",
            &format!("/api/v0/transfers/downloads/{username}"),
            Some(body),
        )
    }

    fn downloads(&self) -> Result<Vec<ApiTransferUser>, SlskdError> {
        self.request("GET", "/api/v0/transfers/downloads", None)
    }

    fn cancel_download(&self, username: &str, id: &str) -> Result<(), SlskdError> {
        self.request_no_content(
            "DELETE",
            &format!("/api/v0/transfers/downloads/{username}/{id}"),
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeSlskd;
    use crate::wire::ServerStatus;

    #[test]
    fn relogin_on_401_then_ok() {
        let fake = FakeSlskd::new();
        fake.push_status(Err(SlskdError::Unauthorized));
        fake.push_status(Ok(ServerStatus {
            is_connected: true,
            is_logged_in: true,
        }));

        let result = call_with_relogin(|| fake.status());
        assert!(result.is_ok());
    }

    #[test]
    fn double_401_is_unauthorized() {
        let fake = FakeSlskd::new();
        fake.push_status(Err(SlskdError::Unauthorized));
        fake.push_status(Err(SlskdError::Unauthorized));

        let result = call_with_relogin(|| fake.status());
        assert!(matches!(result, Err(SlskdError::Unauthorized)));
    }

    #[test]
    fn search_guard_deletes_even_on_error_path() {
        let fake = FakeSlskd::new();

        fn fallible_operation() -> Result<(), SlskdError> {
            Err(SlskdError::Network("boom".to_string()))
        }

        let outcome: Result<(), SlskdError> = (|| {
            let _guard = SearchGuard(&fake, "search-123".to_string());
            fallible_operation()?;
            Ok(())
        })();

        assert!(outcome.is_err());
        assert_eq!(
            fake.delete_search_calls.lock().unwrap().as_slice(),
            &["search-123".to_string()]
        );
    }

    #[test]
    fn conflict_409_maps_to_conflict() {
        assert!(matches!(error_for_status(409), SlskdError::Conflict409));
        assert!(matches!(error_for_status(401), SlskdError::Unauthorized));
        assert!(matches!(error_for_status(500), SlskdError::Http(500)));
    }
}
