//! auth.rs — credenciais do slskd (API key ou usuário/senha).
//!
//! `Debug` manual redige a senha — nunca aparece em log. Onde a credencial
//! vive em disco (se é que vive) é decisão do `slsk/config.rs` na Etapa C;
//! este tipo só carrega o que é necessário em memória para autenticar.

#[derive(Clone)]
pub enum SlskAuth {
    /// Header `X-API-Key` estático — sem sessão, sem expiração, sem retry
    /// de login (spec §Adendo item 1: `web.authentication.apiKeys` existe
    /// mas está vazio hoje; passa a valer quando alguém configurar uma key
    /// no `slskd.yml`).
    ApiKey(String),
    /// JWT via `POST /api/v0/session`, Bearer nos requests seguintes,
    /// re-login single-shot em 401.
    Password { user: String, pass: String },
}

impl std::fmt::Debug for SlskAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlskAuth::ApiKey(_) => f.debug_tuple("ApiKey").field(&"***").finish(),
            SlskAuth::Password { user, .. } => f
                .debug_struct("Password")
                .field("user", user)
                .field("pass", &"***")
                .finish(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_redacts_password() {
        let auth = SlskAuth::Password {
            user: "slskd".to_string(),
            pass: "super-secret".to_string(),
        };
        let rendered = format!("{auth:?}");
        assert!(!rendered.contains("super-secret"));
        assert!(rendered.contains("slskd"));
    }

    #[test]
    fn debug_redacts_api_key() {
        let auth = SlskAuth::ApiKey("top-secret-key".to_string());
        let rendered = format!("{auth:?}");
        assert!(!rendered.contains("top-secret-key"));
    }
}
