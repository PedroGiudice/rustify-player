# Retomada: corrigir o restante da lista mobile (pós auto-update)

<session_metadata>
branch: main
last_commit: 171ee2f
published: rustify-player_0.2.76.apk + android-latest.json (release dev)
linear: CMR-210 (In Progress, E2E pendente) · CMR-211..220 (Backlog)
</session_metadata>

## Contexto rápido

Rustify Player (Tauri 2 + SolidJS + Rust; app Android em `src/mobile/` +
plugin Kotlin `src-tauri/crates/tauri-plugin-rustify-audio`). Na sessão de
26/08 o auto-update Android foi entregue e publicado (v0.2.76): o app
consulta `android-latest.json` no release `dev`, baixa pelo Kotlin, confere
sha256 e instala via `PackageInstaller` com confirmação do sistema. Release
pela VM: `./scripts/release_android.sh` (APK arm64 de 37 MB; bump manual
antes). A 0.2.76 é a PRIMEIRA com o updater — entra no S24 via adb uma vez;
daí em diante o aparelho se atualiza sozinho.

Na mesma sessão, os 11 problemas mobile reportados pelo CEO foram triados no
código e registrados como CMR-211..220, com causa e fix propostos. O que
resta é executá-los — na ordem abaixo — e fechar o E2E do updater quando o
S24 estiver na cmr-auto.

## Arquivos principais

- `docs/contexto/26082026-android-auto-update-e-lista-mobile.md` — contexto detalhado desta sessão (decisões, gotchas, métricas)
- `docs/superpowers/specs/2026-08-24-android-auto-update-design.md` — spec do updater (fonte da verdade do contrato)
- `docs/superpowers/plans/2026-08-24-android-auto-update.md` — plano; Tasks 1-6 feitas, resta só §8 (E2E no aparelho)
- `src/mobile/store.ts` — `playList`/`shuffleList`/`playFolder` (continuidade; CMR-211)
- `src/mobile/components/Dock.tsx` — `TAB_DEFS` (CMR-213)
- `src/mobile/updater.ts`, `src/mobile/screens/Settings.tsx` — estado e UI do updater
- `src-tauri/src/mobile_continuity.rs` — tender (SLACK=2, RADIO_BATCH=4)
- `scripts/android/export_manifest.py` — manifest + covers (CMR-212)
- `CLAUDE.md` seção "Android" — build/release/gotchas (atualizada)

## O que fazer

1. **Leia** o contexto: `docs/contexto/26082026-android-auto-update-e-lista-mobile.md`
2. **Verifique** o ambiente (comandos no fim)
3. **Consulte** o Linear (`mcp__linear__list_issues`, projeto "Rustify Player") — CMR-211..220 têm o diagnóstico
4. **Execute** os passos abaixo em ordem; cada fix = brainstorming curto (bounded) → TDD → commit atômico com `(CMR-XX)`

## Próximos passos (por prioridade)

### 1. CMR-211 — shuffle de playlist arma continuidade "radio"
**Onde:** `src/mobile/store.ts` — `shuffleList` (linha ~258) e `playList` (assinatura com `contextId` e `continuity`)
**O que:** `shuffleList(list, ctx?)` passa a aceitar contexto; `Folder.tsx` chama com `{ contextId: name, continuity: { mode: "off" } }` (paridade com `playFolder`); `Album.tsx`/`Artist.tsx` mantêm o default; `shuffleAll` idem. Origin continua `autoplay`.
**Por que:** a 2 posições do fim o tender anexa lotes do acervo inteiro — é o "shuffle geral" que o CEO vê.
**Verificar:** teste em `src/mobile/queueModel.test.ts` ou novo `store` puro não existe — validar via typecheck + smoke no aparelho (`window.__mobileStore.shuffleList` no CDP; `continuity_status` deve mostrar `mode: off`). Confirmar também se faixa de fora aparece LOGO no início (se sim, causa adicional).

### 2. CMR-213 — Settings duplicado na tabbar
**Onde:** `src/mobile/components/Dock.tsx` — `TAB_DEFS`
**O que:** trocar `{ path: "/settings", label: "Settings", icon: Icon.settings }` por `{ path: "/queue", label: "Queue", icon: Icon.queue }`; Settings fica só no header da Home.
**Por que:** decisão do CEO (menos cluttered); Queue hoje só é alcançável pelo header/Now Playing.
**Verificar:** `npm run typecheck`; `activeTab` em `nav.ts` reconhece `/queue`.

### 3. CMR-218 — shuffle no Now Playing (depende do 1)
**Onde:** `src/mobile/components/NowPlaying.tsx` (controles) + `store.ts`
**O que:** toggle que re-embaralha a CAUDA da fila atual (`truncate_queue(index+1)` + `add_items` do restante embaralhado, preservando origin/contextId por item).
**Por que:** o CEO pediu o botão na now playing bar; o plugin não tem command de shuffle.
**Verificar:** `get_queue` após o toggle mantém a faixa corrente e o mesmo conjunto de ids.

### 4. CMR-220 — like no mobile (+ sync) e ícone custom
**Onde:** plugin Kotlin (`EventJournal` + command `like`), `src-tauri/src/sync_receiver.rs` (desktop grava `liked_at`/`liked_device` em `track_enrichments`), `NowPlaying.tsx`
**O que:** evento `like`/`unlike` no journal com proveniência; receptor desktop faz upsert idempotente; coração no Now Playing (ícone custom: pedir o asset ao CEO — vale pro desktop também).
**Por que:** like do S24 hoje se perde; é o sinal mais forte do motor.
**Verificar:** teste byte a byte do payload no `mobile_sync.rs` (padrão existente) + `cargo test` no desktop.

### 5. CMR-215 — Recently played
**Onde:** `src-tauri/src/mobile.rs` (command `lib_recent_plays` lendo `recents.json` via `ContinuityState`) + shelf na `Home.tsx`
**Verificar:** command devolve as N últimas com `Track` resolvido; typecheck.

### 6. CMR-212 — capas por faixa
**Onde:** `scripts/android/export_manifest.py` (`deploy_covers`) + `src-tauri/src/mobile_library.rs` (`album_cover_path`)
**O que:** exportar cover por track do cache do desktop para `/sdcard/Music/.rustify/covers/<track_id>.jpg` + campo no manifest; fallback pro `cover.jpg` da pasta.
**Verificar:** contagem de covers no `.rustify/covers/` = tracks com capa no Qdrant; amostra visual no aparelho.

### 7. E2E do auto-update (assim que o S24 estiver na cmr-auto) — fecha CMR-210
**Onde:** aparelho + VM
**O que:** `adb install -r` do `rustify-player_0.2.76.apk` (está em `src-tauri/target/android-release/`; ou baixar do release); bump 0.2.77 + `./scripts/release_android.sh`; no app: Settings > Atualização → Buscar → Baixar e instalar → toggle do sistema → confirmação → reabre em 0.2.77 com `device.json`/journal intactos. Repetir com a tela apagada durante o download (`confirm_pending` → diálogo ao reabrir) e cancelando a confirmação (`failed` + "Tentar de novo").
**Verificar:** `adb shell dumpsys package dev.cmr.rustifyplayer | grep versionName`; log Rust via `run-as`; logcat com tag `RustifyUpdater`.

### 8. Depois: CMR-217 (loudness), CMR-214 (favorites reais), CMR-216 (badges), CMR-219 (ícone — asset do CEO)

## Restrições

- Toda mudança de UI/comportamento passa por brainstorming (bounded) e aprovação antes de codar; commits atômicos referenciando o CMR.
- Não recompilar o APK a cada passo: acumular a leva e rodar `./scripts/release_android.sh --dry-run` uma vez; publicar com `--publish-only` após validar. Bump antes.
- Não tocar em `shuffle` como origin (o motor não conhece; sequência de máquina loga `autoplay`).
- Não trocar o keystore (quebra o update por cima). Não reabrir bind em 0.0.0.0.
- `docs/metrics/regua-*` aparecem modificados pelo timer diário — commitar junto, não descartar.

## Como verificar

```bash
cd /home/opc/rustify-player
rtk proxy git status --short            # só docs/metrics/regua-* modificados
npm run typecheck && npx vitest run 2>&1 | tail -3   # 342 passando
cd src-tauri && cargo test -p tauri-plugin-rustify-audio 2>&1 | grep "test result" | head -1   # 12 passed
cd gen/android && ./gradlew :tauri-plugin-rustify-audio:testDebugUnitTest -q && echo KOTLIN_OK   # se "spawn helper": ./gradlew --stop
curl -sL https://github.com/PedroGiudice/rustify-player/releases/download/dev/android-latest.json | jq -r .version   # 0.2.76
```
