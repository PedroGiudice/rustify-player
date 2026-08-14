# Contexto: Base vetorial local no mobile (CMR-190) — conhecimento consolidado

**Data:** 2026-08-14
**Missão:** levar similar-tracks, stations e recommendations pro S24 sem
processo sidecar. Este doc consolida TUDO que a sessão android-v0 apurou
sobre o tema — números medidos, decisões, âncoras de código.
**Par:** `docs/prompts/14082026-mobile-vetores-cmr190.md` (plano de ataque).
**Sessão-mãe:** `docs/contexto/14082026-android-v0-fechamento-ui-mobile.md`.

---

## Números medidos (13-14/08, Qdrant da cmr-auto via túnel 16333)

| Fato | Valor |
|------|-------|
| `rustify_tracks` | 1746 pontos |
| Vetor `mert` (áudio) | 768d, Cosine → cru: 1746×768×4B ≈ **5,4MB** |
| Vetor `lyrics` (BGE-M3) | 1024d, Cosine → cru: ≈ 7,2MB |
| Custo brute-force cosine top-K em 1746×768d | microssegundos (qualquer celular) |
| Cobertura do motor (régua 13/08) | MERT 100%, letra 100% das alcançáveis, vibe 100% |
| play_events | 6567+ pontos; breakdown por device ativo (`s24` nasceu 13/08) |

## Decisões de pé (não relitigar sem fato novo)

- **Sem processo Qdrant no aparelho** — a decisão é sobre PROCESSO sidecar;
  vetores em arquivo + busca in-process são permitidos e desejados.
- **Qdrant Edge: PESQUISAR ANTES de decidir** (pedido explícito do CEO).
  Edge = Qdrant embedded/in-process pra edge devices, estava em private
  beta em 2025. Critérios de adoção: GA? Suporte Android/NDK real? Licença?
  Traz filtros/API que a gente USE? Contra-baseline: brute-force é trivial
  e zero-dependência nesta escala. Decidir com fatos de 2026.
- **Derivação pesada fica no desktop** — o celular consome artefatos
  exportados (mesmo padrão do manifest), não deriva sinal.
- **Sync é união de conjuntos por UUID**; eventos de station no celular
  voltam com `origin: station` e o sinal v3 já desconta origem passiva.

## O insight central (do debate com o CEO, 13/08)

O gap pra stations adaptativas locais NÃO é vetor — é **sinal de gosto**.
`behavioral_signals` deriva do conjunto COMPLETO de play_events (desktop).
Solução: exportar junto do manifest um **snapshot de gosto** (positives/
negatives com pesos, JSON minúsculo) derivado no desktop. Celular =
vetores + snapshot + re-rank local em Rust puro.

**Escopo semântico importante:** similar-tracks e stations são operações
**vetor→vetor** (não precisam de modelo no aparelho — funcionam offline).
Busca semântica por TEXTO precisaria embeddar a query (BGE-M3/MERT no
celular = inviável no v1; alternativa futura: endpoint de embedding via
tailnet). Não confundir os dois ao planejar.

## Rota incremental acordada

1. **Stations precomputadas no manifest** (pools prontos por station,
   recalculados a cada export) — 1-2 dias, prova a UX offline.
2. **Vetores locais + snapshot de gosto + re-rank** (similar-tracks,
   station adaptativa local) — 3-5 dias, mesmo trilho de export.
3. (futuro, se provar necessário) Station remota servida pelo desktop via
   tailnet, na linha do sync receiver.

## Âncoras de código (onde mexer)

| Peça | Path | Papel |
|------|------|-------|
| Export do manifest | `scripts/android/export_manifest.py` | ganha vectors.bin + snapshot + pools (túnel 16333; track_id como STRING no JSON) |
| Biblioteca mobile | `src-tauri/src/mobile_library.rs` | carrega manifest; ganharia load dos vetores (tolerar ausência — manifest velho não pode quebrar) |
| Commands mobile | `src-tauri/src/mobile.rs` | novos commands (ex: `lib_similar_tracks(id, k)`, stations) |
| Derivação de sinal (referência) | `crates/library-indexer/src/qdrant_client.rs` | `derive_behavioral_signals` (pura, testável) — molde do snapshot |
| Contrato IPC | `docs/android/ipc-contrato-v0.md` | estender com os commands novos (IDs sempre string no JS) |
| Spec visual pronta | `docs/design-refs/design_handoff_mobile/` | telas Stations, mood sheet, "Based on your favorites" JÁ desenhadas — cortadas do v0 por falta de trilho, voltam agora |
| Issue | Linear **CMR-190** (High) | arquitetura + pesquisa Edge |

## Restrições herdadas

- IDs de track u64 → STRING no JS (> 2^53 corrompe Number).
- Manifest vive em `/sdcard/Music/.rustify/`; após novo export, `lib_rescan`.
- Compilar na VM; `bun run build` MANUAL antes de `cargo tauri android build`
  (frontend embutido no .so); `bun install` na main após merge de worktree.
- Boot mobile usa `bootCall` (timeout+retry) — invokes de boot novos devem
  passar por ele (race do WebView frio documentada no fechamento).
- ureq Android sem TLS (tailnet é o canal) — irrelevante pra esta missão
  (artefatos chegam via sync de arquivos do acervo, não HTTP).
