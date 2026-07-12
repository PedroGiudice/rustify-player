# Retomada: avaliar novas melhorias do /design + continuar motor v2

## Contexto rápido

Sessão anterior (2026-07-12) shipou 5 releases (0.2.48→0.2.52): motor v2 de
recomendação (best_score + pool duplo no autoplay + re-rank híbrido por vibe +
cap por artista), beat-sync do background calibrado por medição real do kick,
Fase 0 do session-awareness (stations agora logam `origin="station"` nas
continuações e recebem negatives globais — a escuta virou mensurável), e criação
de mood station por chips com o conserto do vocabulário PT→EN do parser. Acervo
1378 tracks, mood 1378/1378. Tudo em `main`, working tree limpo, v0.2.52 a rolar
na cmr-auto.

**A tarefa PRINCIPAL desta nova sessão**: o usuário fez novas melhorias direto no
projeto claude.ai/design (persistent background) e quer que a sessão **puxe e
avalie** essas mudanças. É um trabalho de design→código: entender o que mudou no
handoff e decidir o que trazer pro app.

<session_metadata>
branch: main
last_commit: 97210db (v0.2.52)
design_project_id: c5cabb56-e85e-4944-a8af-65fbe978188b
design_file: design_handoff_persistent_background/Now Playing Persistent Background Preview.html
local_mirror: docs/design-refs/design_handoff_persistent_background/
subagent_model: sonnet (ordem do usuário desde 2026-07-12)
</session_metadata>

## Arquivos principais

- `docs/contexto/12072026-motor-v2-mood-stations-beat-sync.md` — contexto denso desta sessão
- `docs/design-refs/design_handoff_persistent_background/` — espelho local do handoff (HTML = fonte da verdade dos números) + README sincronizado
- `docs/superpowers/specs/2026-07-12-session-awareness-design.md` — design faseado do session-awareness (fases 1-3 pendentes)
- `docs/contexto/09072026-intel-engine-audit.md` — auditoria do motor + seção Motor v2
- `src/shapes.ts` / `src/renderers.ts` / `src/components/SpectrumCanvas.tsx` — o bg persistente (23 shapes × 5 renderers, beat-sync)
- `src/lib/beatBoost.ts` — calibração do beat-sync (expandKick, BEAT_GAIN)
- Linear CMR-123 (motor v2, item 4 pendente), CMR-124 (download paralelo), CMR-125 (cover gerativa)

## Próximos passos (por prioridade)

### 1. Puxar e avaliar as novas melhorias do /design
**Onde:** projeto claude.ai/design `c5cabb56-e85e-4944-a8af-65fbe978188b`,
arquivo `design_handoff_persistent_background/Now Playing Persistent Background
Preview.html`. Espelho local em `docs/design-refs/design_handoff_persistent_background/`.
**O que:** usar a tool DesignSync (deferred — carregar via ToolSearch
`select:DesignSync`) com o projectId ACIMA (cuidado: bug conhecido de contaminar
o projectId com o UUID do task dir — usar o UUID literal daqui). Puxar o HTML
atual, difar contra o espelho local, e mapear o que o usuário mudou (novos
shapes? novos renderers? mudança de fórmula/números? beat-sync? covers?).
**Por que:** pedido explícito do usuário — ele iterou o design e quer avaliação +
decisão do que trazer pro app.
**Verificar:** diff HTML novo vs `docs/design-refs/.../*.html`; listar as mudanças
concretas antes de propor código. NÃO reinterpretar números — o HTML é a fonte.

### 2. Session-awareness Fases 1-3 (se o usuário priorizar sobre outras coisas)
**Onde:** `docs/superpowers/specs/2026-07-12-session-awareness-design.md`.
**O que:** Fase 1 — station em fila incremental (lote de 8, não 40) + topup;
Fase 2 — `radioSession` client-side (seenIds/skippedIds/contextId), skip early
(<0.35 posição relativa) vira negative de sessão no recommend + `context_id`
aditivo nos play_events; Fase 3 — skip trunca a cauda não tocada e rebusca na
hora. Cada fase shippável e mensurável.
**Por que:** é o "skipar 3 ensina a 4ª" que fecha o gap real vs Spotify nas
stations; Fase 0 (medição) já está no ar.
**Verificar:** régua de skip-rate por `origin=station` nos play_events cai vs o
baseline 66.4%.

### 3. Validar motor v2 + mood stations com dados de uso real
**Onde:** Qdrant da cmr-auto (play_events, origin=station/autoplay).
**O que:** após alguns dias de uso, recomputar skip-rate por origin e comparar
com o baseline. Mood stations: confirmar que buscas ("workout", "dark") retornam
faixas (o fix do vocabulário).
**Por que:** o motor v2 foi validado por simulação; a régua real fecha o loop.

## Como verificar (ambiente)

```bash
cd /home/opc/rustify-player
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -1   # Finished
npm run typecheck 2>&1 | tail -1                                   # sem erro
npx vitest run 2>&1 | grep "Tests "                                # 186 passed
# Qdrant da cmr-auto (acervo real):
ssh cmr-auto@100.102.249.9 'curl -s localhost:6333/collections/rustify_tracks | python3 -c "import json,sys; print(json.load(sys.stdin)[\"result\"][\"points_count\"])"'  # 1378
```

## Restrições (não esquecer)

- Código só tem efeito na cmr-auto após `./scripts/release.sh` na VM + `dpkg -i`
  PELO USUÁRIO + restart. SEMPRE lembrar o comando de instalação ao entregar.
- Temas/stations/dados vivem na cmr-auto (config = efeito imediato).
- Track IDs u64 > 2^53 viajam como STRING no wire; nunca i64/as_i64.
- App roda na cmr-auto (MCP bridge `100.102.249.9:9223` quando aberto) — validar
  comportamento no ambiente real, não só na VM. (Medir, não presumir.)
- Nunca restaurar o EQ warm-tilt.
- Subagentes em Sonnet (`model: "sonnet"`); coordenador no modelo da sessão.
- Sem API keys externas — tudo pela subscription.
- CSS só em `src/styles/extractor-lab.css` (components.css é órfão).
