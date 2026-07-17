# Spec: "App full pro" — hardening de superfície de rede

**Data:** 2026-07-17
**Status:** aprovado (carta branca do usuário; decisão de CTO delegado)
**Release alvo:** 0.2.59

## Contexto e pedido

Pedido original: "tornar o app full pro — auth, JWT, etc", reaproveitando o
domínio `aidvlabs.com` e o padrão JWT RS256 da casa (case-knowledge-api,
stj.aidvlabs.com, legalvec.aidvlabs.com). Em clarificação, o usuário
descartou streaming remoto ("streaming em si mata o propósito") e situou o
motivo real do pedido: **segurança**.

## Levantamento (medido em 2026-07-17, cmr-auto)

| Superfície | Estado encontrado | Risco |
|---|---|---|
| MCP bridge `:9223` (tauri-plugin-mcp-bridge) | `bind_address("0.0.0.0")` explícito em `lib.rs`, sem auth | **Crítico**: `webview_execute_js` + `ipc_execute_command` = execução arbitrária de código no app por qualquer nó da LAN doméstica ou tailnet |
| Qdrant sidecar `:6333/:6334` | bind default `0.0.0.0`, sem auth | Alto: biblioteca, play_events e enrichments legíveis e **apagáveis** pela LAN |
| Media server `:19876` | `127.0.0.1` | OK — já fechado |
| CSP / fontes | `@import` de fonts.googleapis.com em runtime | Baixo (privacidade/robustez): dependência de rede externa em runtime, viola a regra no-cdn da casa; fonte some sem internet |
| Updater (`rustify-update.sh`) | gh autenticado + pkexec dpkg, sem assinatura de pacote | Aceitável para single-user; gh auth é a cadeia de confiança |

## Decisão central: fechamento por bind, não JWT

Auth protege um serviço que precisa estar exposto. Sem streaming remoto,
não existe serviço a proteger — as superfícies existentes são consumidas
apenas por `localhost` (app) e pela VM de dev (curator, probes MCP), esta
última alcançável por SSH. Porta que não escuta é camada mais forte que
porta com token: elimina a superfície em vez de guardá-la.

**JWT + `rustify.aidvlabs.com` ficam RESERVADOS, não descartados.**
Gatilho de reabertura: surgir uma superfície que precise ser alcançável de
fora da tailnet (ex.: cliente remoto real). Nesse caso, aplicar o padrão da
casa — cloudflared na cmr-auto + Bearer JWT RS256 com **chave própria** do
rustify (blast radius separado do jurídico), `/api/health` público, mesmo
tooling de emissão.

## Mudanças (fase única)

### 1. MCP bridge → `127.0.0.1`

`src-tauri/src/lib.rs`: `bind_address("0.0.0.0")` → `"127.0.0.1"`.

Fluxo de dev (probes via MCP) passa a exigir túnel SSH aberto na VM:

```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 9223:localhost:9223 cmr-auto@100.102.249.9
# driver_session: host=127.0.0.1 port=9223
```

A chave SSH é a autenticação. Documentado no CLAUDE.md.

### 2. Qdrant sidecar → `127.0.0.1`

`src-tauri/src/qdrant_process.rs`: adicionar
`QDRANT__SERVICE__HOST=127.0.0.1` ao spawn. O app fala `localhost` — zero
impacto funcional.

Consumidores na VM (curator, scripts de classificação) migram para túnel:

```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
```

Defaults atualizados nos scripts (`CURATOR_QDRANT` →
`http://127.0.0.1:16333`), docstrings e `.claude/agents/music-curator.md`
ensinam a abrir o túnel. Porta local 16333 evita colisão com o Qdrant da
própria VM (:6333).

### 3. Fonte bundlada + CSP sem hosts externos

- Instrument Sans (variable, normal + italic) baixada como woff2 e
  bundlada via Vite (`src/assets/fonts/` + `@font-face` no
  extractor-lab.css, `@import` do Google removido).
- CSP em `tauri.conf.json`: remover `https://fonts.gstatic.com` de
  `font-src` e `https://fonts.googleapis.com` de `style-src`. Nenhum host
  externo permanece no CSP.

## Fora de escopo (registrado)

| Item | Por quê | Gatilho de reabertura |
|---|---|---|
| JWT + rustify.aidvlabs.com | Sem serviço exposto a proteger | Cliente remoto real aprovado |
| Updater assinado (minisign/tauri-updater) | gh auth + pkexec cobre single-user | Distribuição a terceiros |
| Contas/multi-usuário/sync | Contradiz o produto (player local single-user) | Mudança de produto |
| API key no Qdrant | Redundante com bind 127.0.0.1 | Reabrir bind por algum motivo |

## Verificação

1. `ssh cmr-auto 'ss -tlnp | grep -E "9223|6333|6334"'` → todos os binds em
   `127.0.0.1` após dpkg + restart.
2. Probe MCP via túnel funciona (driver_session em 127.0.0.1:9223 da VM).
3. `discover_tracks.py --check` via túnel retorna resultado são.
4. App funcional: busca, recomendação, stations (consumo localhost).
5. Grep no bundle: nenhuma referência a googleapis/gstatic em `dist/`.
