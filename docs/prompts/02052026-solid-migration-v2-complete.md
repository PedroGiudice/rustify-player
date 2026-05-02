# Retomada: Finalizar Migracao SolidJS

## Contexto rapido

O frontend do Rustify Player foi migrado de vanilla JS para SolidJS + Vite na branch `feature/solid-migration`. Todas as 14 views estao implementadas e funcionais — layout, navegacao, playback, autoplay, context menus, Signal EQ, video de fundo. O app esta deployado e em uso na cmr-auto.

NADA foi commitado. Ha 30+ arquivos novos/modificados no working tree. O proximo passo critico e commitar e mergear.

## Arquivos principais

- `docs/contexto/02052026-solid-migration-v2-complete.md` — contexto detalhado desta sessao
- `src/tauri.ts` — wrappers IPC tipados (IDs agora `number`, nao `string`)
- `src/views/*.tsx` — todas as 14 views SolidJS
- `src/components/PlayerBar.tsx` — player bar com fixes de play/pause e autoplay
- `src/store/player.ts` — store reativo central
- `src-tauri/tauri.conf.json` — CSP com media-src pra video de fundo
- `src-tauri/src/lib.rs` — media server com porta fixa 19876

## Proximos passos (por prioridade)

### 1. Commitar e mergear
**Onde:** `feature/solid-migration` → `main`
**O que:** Commitar todos os arquivos novos/modificados, mergear na main
**Por que:** 30+ arquivos nao commitados — risco de perda
**Verificar:** `git status` limpo, `git log` mostra commit, main atualizada

### 2. Investigar video de fundo travando
**Onde:** `src/views/NowPlaying.tsx`, media server em `src-tauri/src/lib.rs`
**O que:** O video H.264 720p trava/engasga no WebKitGTK. Nao e CSP (resolvido). Pode ser buffer size do media server HTTP, ou decode competindo com GStreamer do audio.
**Por que:** UX degradada no Now Playing
**Verificar:** Abrir Now Playing, video deve rodar fluido em loop

### 3. Implementar filtro de busca
**Onde:** `src/views/Albums.tsx`, `Artists.tsx`, `Tracks.tsx`
**O que:** O SearchBar emite evento `search-filter` (vanilla) que filtra cards/rows. As views Solid nao escutam esse evento.
**Por que:** Busca na barra de titulo nao filtra nada nessas views
**Verificar:** Digitar na search bar, cards/rows devem filtrar

### 4. Signal import/export EasyEffects
**Onde:** `src/views/Signal.tsx`, funcoes `importPreset`/`exportPreset`
**O que:** Portar `parseEasyEffects`/`toEasyEffects` do signal.js vanilla (linhas 181-336)
**Por que:** Import/export de presets EasyEffects nao funciona (stubs)
**Verificar:** Importar JSON de ~/.config/easyeffects/output/

## Como verificar

```bash
# Build frontend
bun run build

# Build backend
cargo check --manifest-path src-tauri/Cargo.toml

# Release
./scripts/release.sh

# Instalar na cmr-auto
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.0_amd64.deb
```

<session_metadata>
branch: feature/solid-migration
last_commit: 5c7f303 (media server — pre-migration)
uncommitted_changes: 30+ files (14 views, tauri.ts, PlayerBar, store, configs)
app_status: funcional, deployado na cmr-auto
blocking_issue: nenhum (tudo funciona, pendencias sao melhorias)
</session_metadata>
