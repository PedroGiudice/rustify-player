# Proveniência de eventos — device_id + app_version + signal_schema

Data: 2026-08-13. Status: aprovado pelo CEO (design e plano pré-aprovados na sessão).

## Contexto e motivação

Discussão sobre levar o Rustify pro Android concluiu que o desenho certo é
**local-first com sync**: o áudio nunca atravessa a rede; o que sincroniza
entre dispositivos é o log de eventos do motor de inteligência. `play_events`
já é append-only com UUID por ponto e `derive_behavioral_signals` é derivação
pura — sincronizar é união de conjuntos (grow-only set), sem conflito.

O escopo desta rodada é **só a captura**: carimbar cada evento com sua
proveniência a partir de agora, porque evento não capturado é dado
irrecuperável. O mecanismo de sync em si fica para quando existir um segundo
dispositivo (decisão do CEO, 2026-08-13).

Aproveitando que o payload abre uma vez, mata-se também o `V3_CUTOFF`
hardcoded da régua: hoje "qual semântica de sinal gerou este evento" é
inferido por timestamp fixo editado à mão a cada mudança (v0.2.66). Passa a
ser auto-descritivo.

## O que muda

### 1. Carimbo de proveniência nos eventos

Todo ponto novo em `play_events` (via `insert_play_event` E `insert_raw_event`)
ganha três campos de payload:

| campo | tipo | fonte |
|---|---|---|
| `device_id` | keyword | `device.json` no data dir (criado na 1ª execução) |
| `app_version` | keyword | `app.package_info().version` (autoridade: tauri.conf.json) |
| `signal_schema` | integer | const `SIGNAL_SCHEMA = 3` em `qdrant_client.rs` |

- O backend estampa por cima do que vier do frontend em `log_event`
  (autoridade é do backend; frontend não conhece esses campos).
- Eventos legados NÃO são migrados — mesmo padrão do `context_id`
  (cobertura a partir da versão que introduz, sem retrofit).
- `SIGNAL_SCHEMA` incrementa QUANDO a semântica dos sinais mudar (como na
  v0.2.66) — faz parte do checklist de qualquer mudança futura no motor.

### 2. Identidade do dispositivo

`src-tauri/src/device_identity.rs`:

- `load_or_create(data_dir) -> String`: lê `device.json`
  (`{"device_id": "..."}`); se não existe, deriva slug do hostname
  (lowercase, `[a-z0-9-]`, ex.: `cmr-auto`) e persiste. Imutável depois de
  criado — o arquivo é a verdade, não o hostname (renomear a máquina não
  bifurca a identidade).
- Hostname via `/proc/sys/kernel/hostname` → `/etc/hostname` → env
  `HOSTNAME` → fallback `"unknown"`. Sem dependência nova; o app só shippa
  .deb Linux hoje.
- Legível por decisão: UUID opaco tornaria a régua ilegível, e colisão num
  parque de 3 máquinas com hostnames distintos não é risco real.

### 3. Plumbing

- `Provenance { device_id, app_version }` em `library-indexer`;
  `QdrantClient` ganha `provenance: Option<Provenance>` +
  `with_provenance(...)` (builder). Clientes sem provenance (probe, scripts)
  seguem funcionando — só não estampam device/app (o `signal_schema` é
  sempre estampado).
- `IndexerConfig` ganha `device_id: String` e `app_version: String`;
  `Indexer::open` constrói o client já com provenance.
- Montagem do payload extraída em função pura
  (`build_play_event_payload`) para ser testável sem HTTP.

### 4. Likes

`toggle_like`: ao dar like, grava `liked_device` junto com `liked_at`; ao
remover, limpa ambos. `track_enrichments` é mutável (não é log), então a
proveniência aqui é "quem deu o like vigente", não histórico.

### 5. Índices

`create_play_events_indices` ganha `device_id: keyword` e
`signal_schema: integer`. Collection tem ~6.5k pontos — custo nulo, e filtro
funciona mesmo com cobertura parcial de índice (regra qdrant-bulk-ops).

### 6. Régua (`scripts/metrics/autoplay_regua.py`)

Predicado "evento pós-v3" passa a ser:

```
signal_schema >= 3  OU  (campo ausente E started_at >= V3_CUTOFF)
```

`V3_CUTOFF` fica como fallback legado documentado (eventos anteriores a esta
feature não têm o campo). Mudanças futuras de semântica NÃO exigem mais
editar timestamp — só incrementar `SIGNAL_SCHEMA` no Rust.

Quando os eventos pós-v3 tiverem 2+ `device_id` distintos, a régua imprime o
breakdown por dispositivo (hoje é linha morta — um device só).

## O que NÃO muda

- Nenhum byte de áudio, nenhuma decisão de playback, nenhuma UI.
- `rustify_tracks` (derivado do acervo — cada dispositivo re-indexa o seu).
- Nenhuma migração retroativa de eventos.
- Nenhum mecanismo de sync (export/import/reconciliação) — fase futura, sem
  consumidor hoje.
- `derive_behavioral_signals` ignora os campos novos (proveniência não é
  sinal de gosto).

## Erros

- `device.json` ilegível/corrompido: recria do hostname e loga warning
  (perder a identidade num arquivo corrompido não pode derrubar o boot).
- Falha de escrita do `device.json`: usa o valor em memória na sessão e loga
  warning — evento estampado vale mais que identidade persistida.

## Testes

- `build_play_event_payload`: estampa os 3 campos com provenance; sem
  provenance estampa só `signal_schema`; `listen_pct`/`context_id`
  preservados.
- `device_identity`: 1ª chamada cria arquivo; 2ª lê o mesmo valor; arquivo
  existente com id divergente do hostname vence (imutabilidade); slug
  sanitiza maiúsculas/pontos/espaços.
- Régua validada contra os dados reais da cmr-auto após o deploy (eventos
  novos com campo + legados sem).

## Fase futura (fora desta spec, registrada para não perder o desenho)

Sync = união de conjuntos dos `play_events` entre dispositivos +
re-derivação local dos sinais. `track_enrichments`: last-write-wins por
campo com timestamp. Transporte a decidir quando houver segundo dispositivo
(candidatos: endpoint no app, rsync sobre Tailscale, ou API na VM). O motor
NUNCA fica refém de rede: cada dispositivo deriva sinais do log local.

> **Nota (2026-08-26, CMR-220):** o last-write-wins de `track_enrichments`
> está implementado para like/unlike. `toggle_like` (desktop) e
> `apply_synced_like` (like/unlike do S24 chegando pelo sync receiver) gravam
> `like_updated_at` (unix s, mesmo relógio do journal Kotlin). Evento com
> `timestamp` MENOR que o vigente (`like_updated_at`, fallback `liked_at` pros
> likes legados sem o campo) é no-op; igual aplica (replay idempotente,
> double-tap no mesmo segundo na ordem do seq). `liked_device` gravado = o
> `device_id` do evento (nunca re-estampado). Like NUNCA vira ponto em
> `play_events`: `sync_receiver.rs` roteia por `event_type`. Ordem de
> release: o .deb do desktop entra ANTES do APK que emite like — o receiver
> antigo gravaria like como play_event.
