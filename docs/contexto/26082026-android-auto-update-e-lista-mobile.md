# Contexto: auto-update Android entregue + triagem da lista mobile do CEO

**Data:** 2026-08-26
**Sessão:** `main` (`9fbf20b..171ee2f`, 11 commits, 32 arquivos)
**Duração:** ~3h (ultracode: 3 workflows, 39 agentes)

---

## O que foi feito

### 1. Triagem dos 11 problemas do app mobile reportados pelo CEO

Cada item foi mapeado no código antes de qualquer proposta. Virou issue no
Linear (CMR-211..220) com causa e fix proposto. Os dois com causa-raiz
cravada no código:

- **Shuffle de playlist "vira shuffle geral"** (CMR-211): `Folder.tsx` enfileira
  só a pasta, mas `shuffleList` (`src/mobile/store.ts:203`) usa o default de
  continuidade `mode: "radio"`, enquanto o Play da mesma pasta usa `off`
  (regra do CEO 17/08: playlist termina). A 2 posições do fim (`SLACK=2`,
  `mobile_continuity.rs`) o tender anexa lotes de 4 do acervo inteiro.
  Stations (`mode: "station"`, pool próprio) não sofrem disso pelo código.
- **Capas divergentes do desktop** (CMR-212): o mobile não lê arte embutida;
  `mobile_library.rs` usa o `cover.jpg` da PASTA e `export_manifest.py:447`
  elege a capa do primeiro track por diretório (`setdefault`).

### 2. Auto-update Android (CMR-210) — implementado, revisado, publicado

Spec `docs/superpowers/specs/2026-08-24-android-auto-update-design.md`;
plano `docs/superpowers/plans/2026-08-24-android-auto-update.md` (Tasks 1-5
executadas em worktrees paralelos, Task 6 pelo coordenador).

Contrato (wire camelCase, decisão `available` é do Kotlin):

```ts
invoke('app_version')                                   // "0.2.76"
invoke('plugin:rustify-audio|updater_check', { manifestUrl: null })
// { installed, latest, available, apkUrl, sha256, size, canInstall }
invoke('plugin:rustify-audio|updater_install', { url, sha256, size })
// { status: 'started' | 'needs_permission' | 'busy' }
addPluginListener('rustify-audio', 'updater_progress', ev)
// ev.phase: downloading|verifying|installing|confirm_pending|confirming|done|failed
```

`android-latest.json` (release `dev`, URL estável):
`{ "version", "apk_url", "sha256", "size" }`.

Publicado: `rustify-player_0.2.76.apk` (39.360.229 bytes, sha256
`a07d20ad…a551d`) + manifest. Verificado pela URL pública.

### 3. Revisão adversarial (5 lentes, 2 céticos/achado): 6 confirmados, corrigidos em `5fa1dbf`

O sério: **Android 14+ entrega `STATUS_PENDING_USER_ACTION` com
background-activity-launch negado** (`PackageInstallerSession.
sendOnUserActionRequired` → `setPendingIntentBackgroundActivityLaunchAllowed(false)`).
Com o app invisível (tela apagada durante o download), o `startActivity` da
confirmação era descartado em silêncio e a UI travava em "confirming". Fix:
receiver consulta o lifecycle REAL da Activity (`isResumed()` — flag em
onResume/onPause falharia no cold start, o plugin registra depois do primeiro
resume); invisível → `PendingConfirm.intent` + fase `confirm_pending`, disparo
no `onResume` do plugin. Sessões antigas do PackageInstaller são abandonadas a
cada install.

Demais: check manual que falha depois de "atualizado" promovia a "disponível"
(`phaseAfterCheckFailure`); `confirming` deixou de bloquear o botão (diálogo
pode sumir sem status); toast global em falha/conclusão; total -1 não vira
"-0,0 MB"; spec dizia que o frontend abria a tela de permissão (é o Kotlin).

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---|---|---|
| `scripts/release_android.sh` | Criado | build arm64 stripado + manifest + upload; `--dry-run`, `--publish-only`; APK antes do JSON + confere tamanho do asset |
| `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/Updater.kt` | Criado | Semver, UpdateManifest, UpdaterBus, PendingConfirm, HTTP+redirect manual, sha256, PackageInstaller Session |
| `.../android/src/main/java/UpdateInstallReceiver.kt` | Criado | status do instalador; difere confirmação se app invisível |
| `.../android/src/test/java/UpdaterTest.kt` | Criado | JUnit4 (4 testes); `testImplementation org.json` no gradle (android.jar de teste é stub) |
| `.../android/src/main/java/AudioPlugin.kt` | Modificado | `updaterCheck`/`updaterInstall`, sink do evento, `isResumed()`, `onResume()` |
| `.../android/src/main/AndroidManifest.xml` | Modificado | `REQUEST_INSTALL_PACKAGES` + receiver `exported=false` |
| `.../src/{models,commands,mobile,desktop,lib}.rs`, `build.rs`, `permissions/**` | Modificado | 2 commands + permissões autogeradas (commitadas) |
| `src-tauri/src/mobile.rs` | Modificado | command `app_version` |
| `src/mobile/updater.ts` (+`.test.ts`) | Criado | estado, `reduceProgress`, `bootCheckDue` (6h), `phaseAfterCheckFailure`, `bootUpdater` |
| `src/mobile/screens/Settings.tsx` | Modificado | painel "Atualização" |
| `src/mobile/{types,ipc}.ts`, `MobileApp.tsx`, `styles/app.css` | Modificado | tipos, wrappers, `bootUpdater()` após `bootStore()`, `.updbar` |
| `src-tauri/tauri.conf.json` | Modificado | 0.2.75 → 0.2.76 |
| `CLAUDE.md`, `docs/android/ipc-contrato-v0.md`, README do plugin | Modificado | fluxo de release, contrato, gotcha do gradle daemon |
| `docs/metrics/regua-*.{jsonl,md}` | Modificado (não commitado) | saída do timer diário da régua — fora do escopo |

## Commits desta sessão

```
171ee2f docs(android): teste JVM do plugin e gotcha do daemon do Gradle no CLAUDE.md
5fa1dbf fix(android): confirmação do PackageInstaller diferida pro onResume + fases da UI pós-revisão
33399fc fix(android): release_android.sh sobe APK antes do manifest e confere o tamanho do asset
bf62d31 chore: bump 0.2.76
ae2b873 docs(android): auto-update — fluxo de release, contrato IPC e README do plugin
7dbea9d feat(android): release_android.sh — APK arm64 stripado + android-latest.json no release dev
6d5c7d4 feat(android): seção Atualização na Settings + check de boot com throttle
22e0b4f feat(android): updater Kotlin — manifest, download+sha256, PackageInstaller, receiver
7f0c6ed feat(android): commands updater_check/updater_install no plugin + app_version
49cbef9 docs: plano de implementação do auto-update Android
9fbf20b docs: spec do auto-update Android via GitHub Releases
```

## Decisões tomadas

- **GitHub Releases direto (repo público) em vez de servir pelo desktop via tailnet**: funciona de qualquer rede, sem token, sem depender do app desktop ligado. | Descartado: endpoint no sync receiver `:19878` — exigiria desktop ligado + scp do APK pra cmr-auto.
- **HTTP/download no Kotlin, não no Rust**: ureq do Android é sem TLS (gotcha documentado) e GitHub é HTTPS-only. Redirect cross-host (`objects.githubusercontent.com`) seguido manualmente; `Content-Length` real só no 200 final — o `size` do manifest é o total.
- **APK debug arm64 com `CARGO_PROFILE_DEV_STRIP=debuginfo`** (520 MB → 37 MB; .so 140 → 28 MB; `.dynsym` JNI intacto, verificado). | Descartado por ora: build release assinado com o debug keystore — muda o perfil do binário validado no aparelho; fica como evolução separada.
- **Assinatura continua o debug keystore da VM** (backup feito: `cmr-auto:~/backups/rustify-debug.keystore`, sha idêntico). Trocar keystore = reinstalar via adb.
- **Confirmação nunca é silenciosa**: `USER_ACTION_NOT_REQUIRED` só vale pro "installer of record"; o app foi instalado via adb.
- **`updater_install` resolve na hora** (`started`) e o progresso vai por evento: a promise do JS não sobrevive a reload do WebView; o listener é registrado no boot, ANTES de qualquer install (o Kotlin só emite com `hasListener`).
- **`confirming`/`confirm_pending` não contam como ocupado na UI**: o diálogo do sistema pode sumir (Home, ligação) sem status algum; retry re-baixa e abandona a sessão antiga.
- **Ícone custom (CMR-219) e like custom (CMR-220) esperam asset do CEO.**

## Métricas

| Métrica | Valor |
|---|---|
| APK universal debug (antes) | 520 MB (4 ABIs × ~130 MB, DWARF) |
| APK arm64 stripado (agora) | 37 MB (`.so` 28,6 MB) |
| Gates | Rust plugin 12/12 · Kotlin JVM 4/4 · vitest 342/342 · typecheck limpo · cargo check desktop limpo |
| Revisão | 12 achados brutos → 6 confirmados (corrigidos) / 6 refutados |
| versionCode | 2076 (= minor*1000+patch; patch < 1000) |

## Gotchas descobertos

- Gradle daemon com `Failed to exec spawn helper` (Test Executor não inicia) após invocações concorrentes: `./gradlew --stop` resolve; não é código. Documentado no CLAUDE.md.
- Worktrees de subagente: vitest não roda (vite bloqueia `/@fs/` fora do root ao seguir symlink de node_modules) — o agente contornou com config no scratchpad; gradle exige a cola autogerada do Tauri (`tauri.settings.gradle` etc.), gitignored.
- Workflow de leitura reportado como "erro" pelo CEO tinha apenas demorado 24 min; concluiu limpo. Checar `journal.jsonl` e mtimes dos transcripts antes de re-rodar.
- O dist vai embutido COMPRIMIDO no `.so` (feature `compression` do Tauri): `strings` no `.so` não acha texto do frontend; validar pelo dist em disco + mtime do `.so`.

## Pendências identificadas

1. **E2E do auto-update no S24** (alta, bloqueada no aparelho) — CMR-210 fica In Progress. Primeira instalação com o updater é via adb (0.2.76); depois publicar 0.2.77 e validar o ciclo, inclusive tela apagada durante o download (`confirm_pending` → `onResume`) e cancelamento da confirmação (`STATUS_FAILURE_ABORTED` → `failed`).
2. **CMR-211 shuffle de playlist arma rádio** (alta) — fix pequeno em `store.ts` (`shuffleList` com contexto/continuidade off para playlist). Verificar no aparelho se há faixa de fora LOGO NO INÍCIO (aí há outra causa).
3. **CMR-213 Settings duplicado** (alta, trivial) — trocar a aba por Queue em `Dock.tsx` TAB_DEFS.
4. **CMR-218 shuffle no Now Playing** (média) — depende do 211.
5. **CMR-220 like no mobile + ícone custom** (média/alta valor) — plugin (like → journal) + sync receiver desktop gravando `liked_at`/`liked_device`; asset do CEO pro ícone.
6. **CMR-215 histórico (Recently played)** (média) — command `lib_recent_plays` sobre `recents.json`.
7. **CMR-212 capas por faixa** (média) — export do cache do desktop para `.rustify/covers/<track_id>.jpg` + campo no manifest.
8. **CMR-217 normalização de loudness** (média) — LUFS do índice no manifest; `setVolume` + `LoudnessEnhancer`.
9. **CMR-214 favorites → recomendação real**, **CMR-216 badges de qualidade**, **CMR-219 ícone** (baixa / bloqueado no asset).
10. **`docs/metrics/regua-*`** modificados pelo timer e não commitados — commitar junto com a próxima leva (padrão da régua).
11. Follow-up opcional: build release assinado com o debug keystore (APK menor e otimizado) — requer validação de comportamento no aparelho.
