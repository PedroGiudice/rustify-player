# Retomada: TrackRow consolidation + now-playing indicator

## Contexto rápido

Rustify Player (Tauri 2 + SolidJS). Nesta sessão consolidei as 7 listas-linha em
2 componentes compartilhados (`TrackRowTable` Família A / `TrackRowList` Família B/C)
+ `NowPlayingIndicator` + `src/lib/format.ts`, eliminando 3 markups duplicados. O
indicador de "tocando agora" agora aparece passivamente em toda lista (deriva do
store) e **reusa o sprite `.np-mini__vu` da sidebar** (uniformidade — corrigido após
ter criado um sprite divergente). Motion free-wins aplicados (content-visibility
liberado: cmr-auto roda WebKitGTK 2.52.3). Tudo commitado em `main` (working tree
limpo), release **v0.2.30** publicado e **aguardando validação visual** do usuário.

Há um diagnóstico de segurança aberto: o Qdrant da cmr-auto está em `0.0.0.0` sem auth.

<session_metadata>
branch: main
last_commits: d1f23bc, c6f493b
working_tree: clean
pushed: no
release: v0.2.30 (tag dev, publicado)
</session_metadata>

## Arquivos principais

- `src/components/TrackRowTable.tsx` — linha Família A (Tracks/Album/Playlist), slots coverSlot/extraCols
- `src/components/TrackRowList.tsx` — linha Família B/C (Home/History/Queue/QueueDrawer), size default/compact
- `src/components/NowPlayingIndicator.tsx` — indicador; reusa `.np-mini__vu`
- `src/lib/format.ts` — fmtDur, relTime
- `src/styles/extractor-lab.css` — sprite `.np-mini__vu` (L311), modifiers `.npi--*`, regras current, contain/content-visibility
- `docs/contexto/04062026-trackrow-consolidation-now-playing.md` — contexto detalhado
- `docs/plans/2026-06-04-trackrow-consolidation-now-playing.md` — plano (executado por completo)

## Próximos passos (por prioridade)

### 1. Validação visual das 7 telas (aguardando usuário)
**Onde:** app instalado na cmr-auto (`gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.30_amd64.deb`)
**O que:** confirmar alinhamento + indicador em Tracks/Album/Playlist (NPI na coluna #), Home/History/Queue/QueueDrawer (NPI overlay na capa). Confirmar que o equalizer das listas bate com o da sidebar.
**Por que:** build passa com defeito visual; só o olho valida.
**Verificar:** trocar de faixa move o NPI; pausar congela; os 2 pontos intencionais (Home/History novo destaque; Queue fundo→barra).

### 2. Qdrant security na cmr-auto (usuário decide quando)
**Onde:** rodar NA cmr-auto (acesso local — `ufw` via SSH tem risco de lockout)
**O que:**
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on lo            # app local (localhost:6333)
sudo ufw allow in on tailscale0    # tailnet (subagente, SSH, Qdrant)
sudo ufw enable && sudo ufw status verbose
```
**Por que:** Qdrant em 0.0.0.0 sem auth — LAN lê/escreve/apaga as 983 tracks. NÃO rebindar (app usa localhost).
**Verificar:** `ss -tlnp | grep 633` mostra binding; de outra máquina não-tailnet, `curl cmr-auto:6333` deve falhar.

### 3. Doc CLAUDE.md (task #9)
**Onde:** `CLAUDE.md` (raiz do repo)
**O que:** nota pontual sobre `TrackRowTable`/`TrackRowList`/`NowPlayingIndicator`/`format.ts` (onde ficam, qual usar ao criar lista nova); corrigir "Branch atual: `fix-playback-race-condition`" → `main`.
**Por que:** evitar que alguém recrie markup de linha do zero; doc viva.
**Verificar:** `grep -n "fix-playback-race-condition" CLAUDE.md` → 0.

### 4. Limpezas opcionais (baixa)
- Sidebar `vu` JS morto (Sidebar.tsx:41-53) — `setInterval` inócuo (CSS sobrepõe).
- `docs/barrinhas.png` — screenshot de debug commitada; `git rm` se incomodar.
- `git push origin main` — backup remoto.

## Como verificar

```bash
cd /home/opc/rustify-player
git status --short            # vazio
npm run build 2>&1 | tail -2  # "built in ~1s", sem erro
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -1  # Finished
# resíduo (deve ser 0):
grep -rn "function fmtDur\|function relTime\|function QueueRow\|function QRow" src/views/ src/components/QueueDrawer.tsx
```

## Restrições

- **NÃO compilar/release** até acumular mudanças (CLAUDE.md do projeto); `release.sh` é o único caminho de build (cmr-auto puxa o `.deb`). Não compilar local na cmr-auto.
- **NÃO mexer na Sidebar** ao alterar o indicador — ela é a fonte canônica do sprite `.np-mini__vu`.
- **NÃO rebindar** o Qdrant pro IP Tailscale (quebra o app que usa localhost) — usar `ufw`.
- Frontend é **SolidJS/TSX** — editar `src/views/*.tsx`, nunca `src/js/`.
- Workflow tool com `schema` forçado é frágil para agentes de edição longa (StructuredOutput falha) — preferir texto livre + verificação por Bash.
