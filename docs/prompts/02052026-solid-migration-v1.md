# Retomada: Corrigir Migracao SolidJS

## Contexto rapido

O frontend do Rustify Player esta sendo migrado de vanilla JS para SolidJS + Vite na branch `feature/solid-migration`. O Claude Design gerou um bundle de migracao que foi aplicado, mas **o codigo gerado tinha problemas graves**: IPC commands com nomes errados, markup HTML com classes CSS inventadas que nao existem no stylesheet real, e tipos TypeScript incorretos. O layout (grid, titlebar, sidebar, player bar) ja foi corrigido e funciona. Mas nenhuma view renderiza corretamente porque o HTML/classes nao correspondem ao CSS existente.

O padrao correto e simples: cada view `.tsx` deve usar **exatamente o mesmo markup/classes** que o `.js` vanilla original usa — so trocando DOM manipulation manual (`innerHTML`, `querySelector`) por JSX declarativo do Solid.

## Arquivos principais

- `docs/contexto/02052026-solid-migration-v1.md` — contexto detalhado, tabela de status por arquivo
- `src/tauri.ts` — wrappers IPC (nomes corrigidos, mas tipos `id` ainda sao `string` em vez de `number`)
- `src/js/views/*.js` — views vanilla originais (REFERENCIA para o markup correto)
- `src/views/*.tsx` — views Solid (a corrigir)
- `src/styles/components.css` — CSS real com todas as classes

## Proximos passos (por prioridade)

### 1. Corrigir tipos no `tauri.ts`
**Onde:** `src/tauri.ts`, interfaces `Track`, `Album`, `Artist` (linhas 12-45)
**O que:** Trocar `id: string` por `id: number`, `artist_id: string | null` por `number | null`, etc. O backend Rust serializa IDs como `i64`.
**Por que:** Sem isso, comparacoes de ID falham silenciosamente (`"123" !== 123`).
**Verificar:** `bun run build` passa sem erros de tipo.

### 2. Reescrever views migradas com markup correto
**Onde:** `src/views/Album.tsx`, `Artist.tsx`, `Queue.tsx`, `Settings.tsx`
**O que:** Para cada uma, ler o `.js` vanilla correspondente em `src/js/views/`, copiar o HTML markup (classes CSS), e converter pra JSX reativo do Solid. NAO inventar classes — usar as que ja existem no CSS.
**Por que:** O Claude Design inventou classes como `track-row__meta`, `track-row__title` que nao existem. O CSS real usa `track-table` com `<table>`, `track-table__td`, etc.
**Verificar:** Abrir cada view no app e confirmar que renderiza com estilo correto.

**Referencia de mapeamento (vanilla JS → Solid TSX):**

| Pattern vanilla | Equivalente Solid |
|-----------------|-------------------|
| `view.innerHTML = \`...\`` | JSX direto no return |
| `document.querySelector("#id")` | `let ref!: HTMLElement` com `ref={ref}` |
| `el.addEventListener("click", fn)` | `onClick={fn}` |
| `invoke("cmd", args)` | Import de `src/tauri.ts` |
| `listen("event", cb)` | `onMount` + `onCleanup` |
| `convertFileSrc(path)` | `coverUrl(path)` de `tauri.ts` |

### 3. Migrar views stub
**Onde:** `src/views/Home.tsx`, `Albums.tsx`, `Artists.tsx`, `Tracks.tsx`, `History.tsx`, `Stations.tsx`
**O que:** Converter cada `.js` vanilla pra `.tsx` Solid usando o mesmo pattern: ler o .js, replicar o markup, usar `createResource` para dados async, `For` para listas.
**Por que:** Atualmente mostram "Pendente migracao" — app inutilizavel sem elas.
**Verificar:** Navegar pra cada view e confirmar dados + interacao.

### 4. Validar playback end-to-end
**Onde:** `src/components/PlayerBar.tsx`, `src/store/player.ts`
**O que:** Clicar numa track, verificar que play/pause/seek/next/prev/like/volume funcionam.
**Por que:** O store reativo e novo, nunca foi testado em runtime.
**Verificar:** Tocar uma musica, pausar, fazer seek, pular pra proxima.

### 5. Testar video de fundo no Now Playing
**Onde:** `src/views/NowPlaying.tsx`
**O que:** Garantir que o video `bg-video.mp4` em `~/.local/share/rustify-player/media/` carrega via HTTP local.
**Por que:** Media server HTTP (commit `5c7f303`) nunca foi testado end-to-end.
**Verificar:** Abrir Now Playing, verificar se o video de fundo aparece.

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

# Conectar via MCP Tauri e verificar
# mcp__tauri__driver_session start --host 100.102.249.9
# mcp__tauri__webview_dom_snapshot accessibility
# mcp__tauri__read_logs console
```

<session_metadata>
branch: feature/solid-migration
last_commit: 5c7f303 (media server)
uncommitted_changes: 13 files modified, 8 new dirs/files
app_status: layout OK, views broken (markup mismatch)
blocking_issue: views TSX usam classes CSS inexistentes
</session_metadata>
