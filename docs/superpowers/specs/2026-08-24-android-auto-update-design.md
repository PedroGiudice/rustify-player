# Auto-update do app Android (S24) — design

Data: 2026-08-24. Status: aprovado pelo CEO (design em chat).

## Problema

A distribuição v0 do Android é APK debug via `scp` + `adb install` com o
celular plugado na cmr-auto. Não há trilho de update: release nova no
GitHub não chega ao aparelho sozinha. O updater do Tauri é desktop-only —
não existe suporte Android no plugin oficial.

## Fatos que definem a arquitetura

1. **Repo `PedroGiudice/rustify-player` é público.** O aparelho consulta e
   baixa do GitHub Releases sem token, de qualquer rede. Não depende de
   tailnet nem do desktop ligado.
2. **ureq no Android é sem TLS** (gotcha documentado no CLAUDE.md). GitHub
   é HTTPS-only, logo check e download acontecem **no lado Kotlin**
   (TLS da plataforma). O intent de instalação já é Kotlin de qualquer
   forma.
3. **Sideload nunca é 100% silencioso no Android**: o sistema exige
   confirmação do usuário na instalação. Automatizamos detectar + baixar +
   disparar; o toque final é humano.
4. **`versionCode` deriva da semver** (`tauri.properties` autogerado:
   0.2.74 → 2074, fórmula minor*1000+patch). Todo bump de patch incrementa;
   o Android aceita o update por cima. Restrição herdada: patch < 1000.
5. **Assinatura**: o APK é assinado pelo debug keystore da VM
   (`~/.android/debug.keystore`). Update por cima exige a MESMA assinatura.
   Trocar de keystore = desinstalar/reinstalar manual no aparelho (perda
   aceitável mas evitável — não trocar sem decisão explícita). Higiene:
   backup do keystore na cmr-auto.

## Arquitetura

```
release_android.sh (VM)                      S24 (app)
  bun run build                                boot ─→ updater_check ──┐
  cargo tauri android build --debug                                    │
  APK → rustify-player_X.Y.Z.apk      GitHub Releases (tag dev)        │
  gera android-latest.json      ──→     android-latest.json  ←── fetch ┘
  gh release upload --clobber           rustify-player_X.Y.Z.apk
                                              │ updater_install
                                              ▼
                                        download → sha256 → PackageInstaller
                                              → confirmação do sistema
```

## Componentes

### 1. `scripts/release_android.sh` (novo)

- Lê a versão de `src-tauri/tauri.conf.json` (mesma autoridade do desktop).
- `bun run build` **sempre** (gotcha: sem ele o `.so` embute dist velho).
- `cargo tauri android build --debug`.
- Copia o APK universal para `rustify-player_<versão>.apk`.
- Gera `android-latest.json`:
  ```json
  {
    "version": "0.2.76",
    "apk_url": "https://github.com/PedroGiudice/rustify-player/releases/download/dev/rustify-player_0.2.76.apk",
    "sha256": "<hex>",
    "size": 123456789
  }
  ```
- `gh release upload dev <apk> <json> --clobber`.
- Como o `release.sh` desktop, NÃO bumpa versão — bump manual antes.

URL estável que o aparelho consulta:
`https://github.com/PedroGiudice/rustify-player/releases/download/dev/android-latest.json`

### 2. Plugin Kotlin (`tauri-plugin-rustify-audio`) — módulo updater

Dois commands novos (regra dura do crate: `async fn` com `AppHandle<R>` no
lado Rust):

- **`updater_check`** → busca o `android-latest.json`
  (`HttpURLConnection`, timeout 10s, thread própria), compara a `version`
  com o `versionName` instalado (comparação semver no Kotlin — fonte única
  de decisão). Retorna `{available, installed, latest, apkUrl, size}`.
- **`updater_install { url, sha256, size }`** → baixa para
  `cacheDir/updates/update.apk` emitindo progresso pelo bus de eventos do
  plugin (`updater_progress { bytes, total }`), verifica sha256, abre
  sessão `PackageInstaller` e commita — o sistema mostra a confirmação.
  Sem FileProvider: a Session API recebe o stream direto.

Manifest: `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>`.
Se `canRequestPackageInstalls()` for false, o command devolve
`needs_permission` e o frontend dispara o intent
`ACTION_MANAGE_UNKNOWN_APP_SOURCES` (toggle único por install).

### 3. Frontend mobile (Settings + boot)

- **Settings, seção "Atualização"**: versão instalada, botão "Buscar
  atualização"; havendo update, card com versão nova + botão "Baixar e
  instalar" com barra de progresso.
- **Boot check**: não bloqueante, throttle de 6h (`kv-mobile-upd-check` no
  localStorage). Update disponível → toast "Atualização X.Y.Z disponível —
  veja em Settings". Falha de rede no boot é silenciosa (log).

## Tratamento de erro

- Check manual falhou → toast com o erro. Check de boot falhou → só log.
- Download interrompido/sha divergente → apaga o parcial, toast, estado
  volta a "disponível" (retry é re-tocar o botão).
- Manifest com semver malformada → trata como "sem update" e loga.
- Cache: `cacheDir/updates/` é limpo antes de cada download.

## Testes

- Comparação semver e parse do manifest: lógica isolada no Kotlin; a
  validação automatizada real é limitada (não há harness de teste Kotlin
  no plugin) — o contrato é exercitado por E2E manual.
- `release_android.sh`: modo `--dry-run` (gera JSON e imprime, não sobe).
- E2E manual (roteiro): instalar versão N no S24, publicar N+1 pela VM,
  abrir o app → banner → download → confirmação → app reabre em N+1 e o
  `device.json`/journal permanecem (update in-place, não reinstall).
- Sem o aparelho conectado: implementação e build saem agora; E2E fica
  pendente até o S24 estar acessível.

## Fora de escopo

- Updater desktop (já existe trilho .deb próprio).
- Release keystore/assinatura de produção; loja; delta updates; rollback.
- Auto-instalação sem confirmação (exigiria device owner/root).

## Higiene incluída

- Backup do `~/.android/debug.keystore` da VM para a cmr-auto
  (`~/backups/rustify-debug.keystore`). Perder esse arquivo mata o trilho
  de update (assinatura divergente em todo APK futuro).
