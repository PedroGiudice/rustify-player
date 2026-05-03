# Qdrant Point IDs: sempre u64

Track IDs no Qdrant são u64 (hash-based, valores > i64::MAX são comuns).
NUNCA usar i64 para point IDs — overflow silencioso gera IDs negativos
que o Qdrant não encontra, causando falhas em recommend, scroll, etc.

- `QdrantClient` methods: todos os parâmetros e retornos de point ID são `u64`
- JSON serialização: `serde_json::json!` serializa u64 como número positivo
- Leitura de JSON: usar `as_u64()`, nunca `as_i64()` para point IDs
- `i64` é válido apenas para timestamps, durations, offsets — nunca para IDs
