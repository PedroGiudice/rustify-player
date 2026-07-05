# Retomada: Pós Themes Boost — validação v0.2.38, renderings, ajuste fino

## Contexto rápido

A sessão anterior entregou o **themes boost completo**: schema YAML novo
(tones/glass/radius/shadows/motion/background.ink/effects.halo) no parser,
superfícies CSS tematizáveis (halos via color-mix, glass tokens, ::selection),
**adaptive ink** (bg e linhas do spectrum seguem a cor da capa, com precedência
usuário > capa > tema > default e dirty-flag), subagente **theme-maker**,
extração de cor **v2** no Rust (quantização saturation-aware, enrichment
`dominant_color_v2` recalcula lazy) e um **review de 8 finders que corrigiu 9
bugs**. Tudo em **v0.2.38 publicada** — mas o usuário só instalou a v0.2.37:
a 0.2.38 ainda não roda na cmr-auto.

Os 12 temas YAML (WCAG AA + seções boost) já estão deployados em
`~/.local/share/rustify-player/themes/` na cmr-auto. O app roda LÁ
(`cmr-auto@100.102.249.9`); MCP bridge na porta 9223 quando aberto.

## Arquivos principais

- `docs/contexto/05072026-themes-boost-adaptive-ink-review.md` — contexto denso da sessão
- `docs/superpowers/specs/2026-07-05-themes-boost-design.md` — spec do boost
- `docs/design-refs/2026-07-05-now-playing-persistent-bg-NOTES.md` — leitura do rendering (renderers/shapes futuros)
- `src/lib/adaptiveInk.ts` — deriveInk v2 + wiring (guards, retry, re-derive)
- `src/store/tweaks.ts` — resolver de precedência do ink, dirty-flag, listener theme-applied
- `src-tauri/crates/library-indexer/src/cover.rs` — dominant_color v2
- `src-tauri/src/lib.rs` — parser de temas (yaml_key_to_css_prop, load_theme) + get_track_color
- `scripts/themes/validate.py` — validador offline (12/12 obrigatório pré-deploy)
- `.claude/agents/theme-maker.md` — subagente pra criar/upgradar temas

## Próximos passos (por prioridade)

### 1. Instalar e validar a v0.2.38 na cmr-auto
**Onde:** cmr-auto (usuário roda o dpkg; app precisa REINICIAR pra trocar o binário)
**O que:** `gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.38_amd64.deb` + fechar/abrir o app
**Por que:** a 0.2.38 tem a extração de cor v2 e os 9 fixes do review; sem ela o ink continua lamacento
**Verificar:** via MCP (driver_session 100.102.249.9:9223) — trocar de faixa e ler `--bg-ink-rgb` (getComputedStyle); a cor deve ser saturada e recalcular por faixa (1º play grava `dominant_color_v2` no enrichment)

### 2. Ajuste fino da saturação/luminância do ink por feedback
**Onde:** `src/lib/adaptiveInk.ts` (`deriveInk`: piso 0.35, boost 1.6x, L ancorada no tema) e/ou `cover.rs` (pesos da quantização)
**O que:** iterar com o usuário OUVINDO/VENDO o resultado — ele reportou "precisa de mais saturação considerando o tema atual" ANTES da v2; a v2 pode bastar ou precisar de mais um passo
**Por que:** é feedback estético; só o olho dele fecha o loop
**Verificar:** trocar faixas de capas conhecidas (vermelha, azul, cinza) e conferir hue preservado + presença

### 3. Renderings do design system (GATED no usuário)
**Onde:** projeto claude.ai "rustify-player" (`c5cabb56-e85e-4944-a8af-65fbe978188b`) via `/design-login` + DesignSync (get_file; list_projects NÃO mostra projetos tipo comum — usar o projectId direto)
**O que:** o usuário está adicionando renderings; ele trará pickup prompt próprio. Implementação esperada: 5 renderers (mesh/columns/weave/dots/contour) + 5 shapes radiais + nav render/shape na NowPlaying — mapa completo em `docs/design-refs/2026-07-05-now-playing-persistent-bg-NOTES.md`
**Por que:** evolução do bg persistente; NÃO implementar antes do pacote completo (retrabalho)
**Verificar:** —

### 4. Mistério das 1500 músicas (pergunta original nunca respondida)
**Onde:** cmr-auto — Qdrant local (:6333, collection rustify_tracks) + `~/Music`
**O que:** a soma das tracks das playlists < ~1500 arquivos baixados. Medir: `find ~/Music -type f \( -iname '*.flac' -o -iname '*.mp3' \) | wc -l` vs count do Qdrant vs soma por playlist (pasta 1º nível = playlist)
**Por que:** o usuário reportou e a sessão foi desviada pra distorção de áudio antes de investigar
**Verificar:** números batendo ou causa nomeada (arquivos fora de pasta-playlist, não indexados, duplicatas)

### 5. Tech debt CMR-112 (Linear) — 7 itens
**Onde:** https://linear.app/cmr-auto/issue/CMR-112
**O que:** conversores de cor triplicados → `src/lib/color.ts`; tokens de halo derivados; THEME_GOVERNED genérico; canal de tema pro lyricsGlass; 1-IPC pro ink (command `get_current_track_color`); componente ResetToTheme; cor de capa compartilhada com Visualizer
**Por que:** qualidade; nenhum é bug
**Verificar:** typecheck + npm test + cargo test

## Restrições

- **NÃO restaurar o EQ warm-tilt** do usuário (ordem explícita; EQ interno OFF persistido)
- **NÃO recompilar na cmr-auto** — release.sh na VM é o único caminho; toda release exige dpkg -i pelo usuário + restart do app
- Temas vivem SÓ na cmr-auto; deploy por scp; validar com `scripts/themes/validate.py` antes (12/12)
- Mudança de código só tem efeito aí após release + dpkg; config (YAML/localStorage) tem efeito imediato (hot-reload de tema)
- `decoder_roundtrip` é flaky sob `cargo test --workspace` paralelo (contention de engine) — passa isolado; não é regressão

<session_metadata>
branch: main
last_commit: 53ce2eb
released: v0.2.38 (publicada, NÃO instalada na cmr-auto)
installed_cmr_auto: v0.2.37
themes_deployed: 12/12 (WCAG + boost, na cmr-auto)
linear: CMR-112 (tech debt, backlog)
</session_metadata>

## Como verificar (smoke tests da nova sessão)

```bash
# Ambiente do repo
cd /home/opc/rustify-player
npm run typecheck && npm test 2>&1 | grep Tests        # 107 passed
cargo test --manifest-path src-tauri/Cargo.toml --lib  # 13 passed

# Estado da cmr-auto
ssh cmr-auto@100.102.249.9 'dpkg -l rustify-player | tail -1'   # qual versão?
python3 scripts/themes/validate.py <(ssh cmr-auto@100.102.249.9 'cat ~/.local/share/rustify-player/themes/theme-copper-default.yaml') 2>/dev/null || \
  echo "validar puxando os YAML por scp se necessário"
```
