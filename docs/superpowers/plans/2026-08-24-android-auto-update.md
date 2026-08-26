# Auto-update Android — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o app Android verifica no GitHub Releases se há versão nova, baixa o APK e dispara a instalação (com a confirmação do sistema), sem adb.

**Architecture:** um script na VM publica `rustify-player_X.Y.Z.apk` + `android-latest.json` no release `dev`; o plugin Kotlin `rustify-audio` ganha dois commands (`updater_check`, `updater_install`) que fazem HTTP com o TLS da plataforma, verificam sha256 e commitam uma `PackageInstaller.Session`; um `BroadcastReceiver` do plugin reencaminha o status (confirmação do usuário / falha); o frontend expõe tudo numa seção da Settings e faz um check silencioso no boot.

**Tech Stack:** Kotlin (HttpURLConnection, PackageInstaller Session API, JUnit4), Rust (tauri 2 plugin mobile, serde), SolidJS + vitest, bash (`gh`, `jq`, `sha256sum`).

**Spec:** `docs/superpowers/specs/2026-08-24-android-auto-update-design.md`

## Global Constraints

- Command novo do plugin no Rust DEVE ser `async fn` com `AppHandle<R>` (State síncrono deadlocka a main thread — README do crate).
- Wire Kotlin↔JS em **camelCase**; ids/versões como String.
- Repo público `PedroGiudice/rustify-player`, tag rolling `dev`. URL estável do manifest: `https://github.com/PedroGiudice/rustify-player/releases/download/dev/android-latest.json`.
- Nenhum HTTP no Rust do Android (ureq sem TLS). Download e check ficam no Kotlin.
- Assinatura: debug keystore da VM (`~/.android/debug.keystore`, backup em `cmr-auto:~/backups/rustify-debug.keystore`). Nunca trocar sem decisão do CEO.
- Build do APK: `--debug --target aarch64` com `CARGO_PROFILE_DEV_STRIP=debuginfo` (mede: .so 140 MB → 27,7 MB; JNI intacto).
- `bun run build` é OBRIGATÓRIO antes de `cargo tauri android build` (o dist é embutido no .so).
- Zero emoji, PT-BR nos comentários/documentação.
- Não compilar o APK em tarefas intermediárias: a compilação Android acontece UMA vez, na Task 6.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs` | structs serde do wire do updater (+ testes) |
| `.../src/commands.rs`, `src/mobile.rs`, `src/desktop.rs`, `src/lib.rs`, `build.rs`, `permissions/default.toml` | 2 commands novos + permissões |
| `.../android/src/main/java/Updater.kt` | Semver, parse do manifest, HTTP, download+sha256, PackageInstaller |
| `.../android/src/main/java/UpdateInstallReceiver.kt` | recebe status do PackageInstaller, abre a confirmação do sistema |
| `.../android/src/main/java/AudioPlugin.kt` | commands `updaterCheck`/`updaterInstall` + sink do evento `updater_progress` |
| `.../android/src/main/AndroidManifest.xml` | permissão `REQUEST_INSTALL_PACKAGES` + receiver |
| `.../android/src/test/java/UpdaterTest.kt` | JUnit4: Semver + manifest |
| `src-tauri/src/mobile.rs` | command `app_version` (versão instalada, offline) |
| `src/mobile/types.ts`, `src/mobile/ipc.ts` | tipos + wrappers |
| `src/mobile/updater.ts` (+ `updater.test.ts`) | estado do updater, throttle do boot, reducer de progresso |
| `src/mobile/screens/Settings.tsx`, `src/mobile/MobileApp.tsx`, `src/mobile/styles/app.css` | seção "Atualização", boot check, barra |
| `scripts/release_android.sh` | build + manifest + upload |
| `CLAUDE.md`, `docs/android/ipc-contrato-v0.md`, `.../tauri-plugin-rustify-audio/README.md` | documentação viva |

---

### Task 1: Plugin Rust — models, commands, permissões, `app_version`

**Files:**
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs` (fim do arquivo, antes de `#[cfg(test)]`; e testes no `mod tests`)
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs` (fim)
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs` (dentro do `impl<R: Runtime> RustifyAudio<R>`, fim)
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/src/desktop.rs` (idem)
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/src/lib.rs` (`generate_handler!`)
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/build.rs` (`COMMANDS`)
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/permissions/default.toml`
- Modify: `src-tauri/src/mobile.rs` (novo command + `generate_handler!`)

**Interfaces:**
- Produces (JS chama): `plugin:rustify-audio|updater_check { manifestUrl?: string }` → `UpdateCheck`; `plugin:rustify-audio|updater_install { url, sha256?, size? }` → `{ status: "started"|"needs_permission"|"busy" }`; `app_version` → `string`.
- Produces (Rust chama Kotlin): métodos `updaterCheck(UpdaterCheckRequest)` e `updaterInstall(UpdaterInstallRequest)` — a Task 2 implementa com esses nomes e esse wire.

- [ ] **Step 1: Testes de wire em `models.rs`** — adicionar dentro do `mod tests` existente:

```rust
    /// Wire do Kotlin para `updater_check`. `sha256` pode vir `null` (manifest
    /// antigo) e `size` ausente — o parser não pode quebrar por isso.
    #[test]
    fn update_check_le_o_wire_do_kotlin() {
        let wire = r#"{"installed":"0.2.75","latest":"0.2.76","available":true,
            "apkUrl":"https://github.com/PedroGiudice/rustify-player/releases/download/dev/rustify-player_0.2.76.apk",
            "sha256":null,"canInstall":false}"#;
        let c: UpdateCheck = serde_json::from_str(wire).unwrap();
        assert_eq!(c.installed, "0.2.75");
        assert_eq!(c.latest, "0.2.76");
        assert!(c.available);
        assert_eq!(c.sha256, None);
        assert_eq!(c.size, 0);
        assert!(!c.can_install);
        assert!(c.apk_url.as_deref().unwrap().ends_with("rustify-player_0.2.76.apk"));
    }

    /// O request de install sai em camelCase — o Kotlin lê `sha256`/`size`
    /// com default, mas `url` é obrigatória.
    #[test]
    fn updater_install_request_serializa_em_camel_case() {
        let req = UpdaterInstallRequest {
            url: "https://x/y.apk".into(),
            sha256: Some("ab".into()),
            size: 10,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"url\":\"https://x/y.apk\""), "{json}");
        assert!(json.contains("\"sha256\":\"ab\""), "{json}");
        assert!(json.contains("\"size\":10"), "{json}");
    }

    #[test]
    fn updater_check_request_omite_url_nula_como_null() {
        let req = UpdaterCheckRequest { manifest_url: None };
        assert_eq!(serde_json::to_string(&req).unwrap(), r#"{"manifestUrl":null}"#);
    }

    #[test]
    fn updater_install_result_le_status() {
        let r: UpdaterInstallResult = serde_json::from_str(r#"{"status":"needs_permission"}"#).unwrap();
        assert_eq!(r.status, "needs_permission");
    }
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/opc/rustify-player/src-tauri && cargo test -p tauri-plugin-rustify-audio update 2>&1 | tail -20`
Expected: erro de compilação (`UpdateCheck` não definido).

- [ ] **Step 3: Structs em `models.rs`** — inserir ANTES de `/// Payload vazio.`:

```rust
/// Pedido de `updater_check`. `manifest_url` só existe para teste; `None`
/// usa a URL fixa do release `dev` (definida no Kotlin).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckRequest {
    #[serde(default)]
    pub manifest_url: Option<String>,
}

/// Resposta de `updater_check`. A decisão `available` é do Kotlin (comparação
/// semver contra o `versionName` instalado) — fonte única.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub installed: String,
    pub latest: String,
    pub available: bool,
    #[serde(default)]
    pub apk_url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: i64,
    /// `canRequestPackageInstalls()` — false até o usuário liberar "instalar
    /// apps desconhecidos" para o app (toggle único por install).
    pub can_install: bool,
}

/// Pedido de `updater_install`. `sha256`/`size` vêm do manifest; ausentes,
/// o Kotlin pula a verificação correspondente.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterInstallRequest {
    pub url: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: i64,
}

/// `started` (download em andamento; progresso pelo evento `updater_progress`),
/// `needs_permission` (abriu a tela do sistema; o JS re-tenta depois) ou
/// `busy` (já havia um download rodando).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterInstallResult {
    pub status: String,
}
```

- [ ] **Step 4: Commands em `commands.rs`** — anexar ao fim:

```rust
// ── Atualização (spec 2026-08-24-android-auto-update) ────────────────────
// HTTP e PackageInstaller vivem no Kotlin: o ureq do Android é sem TLS e o
// GitHub é HTTPS-only.

#[tauri::command]
pub(crate) async fn updater_check<R: Runtime>(
    app: AppHandle<R>,
    manifest_url: Option<String>,
) -> crate::Result<UpdateCheck> {
    audio(&app)
        .updater_check(UpdaterCheckRequest { manifest_url })
        .await
}

#[tauri::command]
pub(crate) async fn updater_install<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    sha256: Option<String>,
    size: Option<i64>,
) -> crate::Result<UpdaterInstallResult> {
    audio(&app)
        .updater_install(UpdaterInstallRequest {
            url,
            sha256,
            size: size.unwrap_or(0),
        })
        .await
}
```

- [ ] **Step 5: `mobile.rs`** — dentro do `impl<R: Runtime> RustifyAudio<R>`, após `remove_listener`:

```rust
    pub async fn updater_check(&self, request: UpdaterCheckRequest) -> crate::Result<UpdateCheck> {
        self.call("updaterCheck", request).await
    }

    pub async fn updater_install(
        &self,
        request: UpdaterInstallRequest,
    ) -> crate::Result<UpdaterInstallResult> {
        self.call("updaterInstall", request).await
    }
```

- [ ] **Step 6: `desktop.rs`** — no `impl`, após `remove_listener`:

```rust
    pub async fn updater_check(&self, _request: UpdaterCheckRequest) -> crate::Result<UpdateCheck> {
        Err(Error::UnsupportedPlatform)
    }

    pub async fn updater_install(
        &self,
        _request: UpdaterInstallRequest,
    ) -> crate::Result<UpdaterInstallResult> {
        Err(Error::UnsupportedPlatform)
    }
```

- [ ] **Step 7: `lib.rs`** — em `generate_handler![ ... ]`, após `commands::remove_listener,` adicionar:

```rust
            commands::updater_check,
            commands::updater_install,
```

- [ ] **Step 8: `build.rs`** — em `COMMANDS`, após `"remove_listener",`:

```rust
    "updater_check",
    "updater_install",
```

- [ ] **Step 9: `permissions/default.toml`** — na lista `permissions`, após `"allow-remove-listener",`:

```toml
  "allow-updater-check",
  "allow-updater-install",
```

- [ ] **Step 10: `src-tauri/src/mobile.rs`** — antes de `pub fn run()`:

```rust
/// Versão instalada (tauri.conf.json embutida no APK). Serve à Settings
/// offline; a comparação com o release é do plugin (`updater_check`).
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}
```

e em `generate_handler![`, após `continuity_status,`: `app_version,`.

- [ ] **Step 11: Compilar o plugin no host (gera `permissions/autogenerated`) e rodar os testes**

Run: `cd /home/opc/rustify-player/src-tauri && cargo check -p tauri-plugin-rustify-audio 2>&1 | tail -5 && cargo test -p tauri-plugin-rustify-audio 2>&1 | tail -15`
Expected: `test result: ok` com os 4 testes novos; arquivos novos `permissions/autogenerated/commands/updater_check.toml` e `updater_install.toml` gerados (o `reference.md` e `schemas/schema.json` também mudam).

Run: `ls src-tauri/crates/tauri-plugin-rustify-audio/permissions/autogenerated/commands/ | grep updater`
Expected: os dois arquivos.

Run: `cd /home/opc/rustify-player/src-tauri && cargo check --target aarch64-linux-android 2>&1 | tail -5` — **só se** o toolchain android estiver no PATH (`rustup target list --installed | grep aarch64-linux-android`). Se falhar por linker/NDK, ignorar: o build real acontece na Task 6.

- [ ] **Step 12: Commit**

```bash
cd /home/opc/rustify-player
git add src-tauri/crates/tauri-plugin-rustify-audio src-tauri/src/mobile.rs
git commit -m "feat(android): commands updater_check/updater_install no plugin + app_version

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Kotlin — Updater, receiver, commands, manifest, teste JVM

**Files:**
- Create: `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/Updater.kt`
- Create: `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/UpdateInstallReceiver.kt`
- Create: `src-tauri/crates/tauri-plugin-rustify-audio/android/src/test/java/UpdaterTest.kt`
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt`
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/AndroidManifest.xml`

**Interfaces:**
- Consumes: os nomes/wire da Task 1 — métodos `updaterCheck` (args `{manifestUrl?}`) e `updaterInstall` (args `{url, sha256?, size?}`).
- Produces: evento `updater_progress` com payload `{ phase, bytes?, total?, message? }`, `phase` ∈ `downloading | verifying | installing | confirming | done | failed`. A Task 3 consome exatamente esses nomes.

- [ ] **Step 1: Teste JVM** — criar `android/src/test/java/UpdaterTest.kt`:

```kotlin
package app.tauri.rustifyaudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterTest {
    @Test
    fun semver_compara_por_componente_numerico() {
        assertTrue(Semver.compare("0.2.76", "0.2.75") > 0)
        assertTrue(Semver.compare("0.2.75", "0.2.76") < 0)
        assertEquals(0, Semver.compare("0.2.75", "0.2.75"))
        // 0.10 > 0.9 (numérico, não lexicográfico)
        assertTrue(Semver.compare("0.10.0", "0.9.9") > 0)
        // prefixo v e sufixo não numérico são tolerados
        assertTrue(Semver.compare("v1.0.0", "0.9.0") > 0)
        assertEquals(0, Semver.compare("1.2.3-debug", "1.2.3"))
    }

    @Test
    fun manifest_parse_le_os_quatro_campos() {
        val m = UpdateManifest.parse(
            """{"version":"0.2.76","apk_url":"https://h/x.apk","sha256":"AB","size":42}"""
        )
        assertEquals("0.2.76", m.version)
        assertEquals("https://h/x.apk", m.apkUrl)
        assertEquals("AB", m.sha256)
        assertEquals(42L, m.size)
    }

    @Test
    fun manifest_parse_tolera_sha_e_size_ausentes() {
        val m = UpdateManifest.parse("""{"version":"0.2.76","apk_url":"https://h/x.apk"}""")
        assertNull(m.sha256)
        assertEquals(0L, m.size)
    }

    @Test(expected = IllegalArgumentException::class)
    fun manifest_parse_rejeita_sem_version() {
        UpdateManifest.parse("""{"apk_url":"https://h/x.apk"}""")
    }
}
```

- [ ] **Step 2: Tentar rodar (deve falhar por classe inexistente)**

Run: `cd /home/opc/rustify-player/src-tauri/gen/android && ./gradlew :tauri-plugin-rustify-audio:testDebugUnitTest -q 2>&1 | tail -15`
Expected: falha de compilação (`Semver`/`UpdateManifest` não existem). Se o gradle falhar por AMBIENTE (ex.: `tauri.settings.gradle` ausente, daemon), registrar a saída e seguir — a Task 6 tenta de novo após o build do APK, que regenera os arquivos do Tauri.

- [ ] **Step 3: `Updater.kt`**

```kotlin
package app.tauri.rustifyaudio

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.tauri.Logger
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Evento de progresso para o JS. Payload: `{ phase, bytes?, total?, message? }`. */
const val EVENT_UPDATER_PROGRESS = "updater_progress"

/** URL estável: o release `dev` é rolling e o JSON é sobrescrito a cada publish. */
const val UPDATE_MANIFEST_URL =
    "https://github.com/PedroGiudice/rustify-player/releases/download/dev/android-latest.json"

/** Action do PendingIntent que o PackageInstaller responde (explícito, mutável). */
const val INSTALL_STATUS_ACTION = "app.tauri.rustifyaudio.UPDATE_INSTALL_STATUS"

/**
 * Comparação semver "a.b.c". Sufixo não numérico de cada componente é
 * ignorado ("3-debug" -> 3); prefixo "v" tolerado. `> 0` se `a` é mais nova.
 */
object Semver {
    fun parse(v: String): IntArray {
        val parts = v.trim().removePrefix("v").split(".")
        return IntArray(3) { i ->
            parts.getOrNull(i)?.takeWhile { it.isDigit() }?.toIntOrNull() ?: 0
        }
    }

    fun compare(a: String, b: String): Int {
        val pa = parse(a)
        val pb = parse(b)
        for (i in 0 until 3) {
            if (pa[i] != pb[i]) return pa[i].compareTo(pb[i])
        }
        return 0
    }
}

/** `android-latest.json` publicado pelo `scripts/release_android.sh`. */
data class UpdateManifest(
    val version: String,
    val apkUrl: String,
    val sha256: String?,
    val size: Long,
) {
    companion object {
        fun parse(text: String): UpdateManifest {
            val o = JSONObject(text)
            val version = o.optString("version", "")
            val url = o.optString("apk_url", "")
            require(version.isNotEmpty() && url.isNotEmpty()) { "manifest sem version/apk_url" }
            return UpdateManifest(
                version = version,
                apkUrl = url,
                sha256 = o.optString("sha256", "").takeIf { it.isNotEmpty() },
                size = o.optLong("size", 0L),
            )
        }
    }
}

/**
 * Canal updater -> plugin -> webview (mesmo padrão do [PlaybackBus]). Perder
 * evento aqui só atrasa a UI: a instalação em si é conduzida pelo sistema.
 */
object UpdaterBus {
    interface Sink {
        fun onUpdaterEvent(payload: JSObject)
    }

    @Volatile
    var sink: Sink? = null

    fun emit(phase: String, fill: (JSObject) -> Unit = {}) {
        val o = JSObject()
        o.put("phase", phase)
        fill(o)
        sink?.onUpdaterEvent(o)
    }
}

/**
 * Check + download + instalação. HTTP fica AQUI (TLS da plataforma): o ureq
 * do lado Rust é compilado sem TLS no Android e o GitHub é HTTPS-only.
 *
 * A instalação usa a Session API do PackageInstaller: o APK é copiado para a
 * sessão e o `commit` entrega o status a [UpdateInstallReceiver]. Sideload
 * nunca é silencioso — o sistema pede confirmação ao usuário.
 */
object Updater {
    private const val TAG = "RustifyUpdater"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 30_000
    private const val MAX_REDIRECTS = 5
    private const val BUF = 256 * 1024

    @Volatile
    private var busy = false

    fun installedVersion(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "0"
    } catch (e: Exception) {
        "0"
    }

    /** Antes do Android 8 não existe o toggle; a partir dele é por app. */
    fun canInstall(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ctx.packageManager.canRequestPackageInstalls()

    /** Abre a tela "instalar apps desconhecidos" já filtrada para este app. */
    fun openInstallPermissionSettings(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:${ctx.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent)
    }

    fun fetchManifest(url: String, userAgent: String): UpdateManifest {
        val conn = open(url, userAgent)
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code ao ler o manifest")
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            return UpdateManifest.parse(text)
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Dispara download + verificação + instalação numa thread própria. Retorna
     * `false` se já há uma rodada em andamento (segundo toque no botão).
     */
    fun startDownloadAndInstall(
        ctx: Context,
        url: String,
        sha256: String?,
        size: Long,
        userAgent: String,
    ): Boolean {
        if (busy) return false
        busy = true
        Thread({
            try {
                val apk = download(ctx, url, sha256, size, userAgent)
                install(ctx, apk)
            } catch (e: Exception) {
                Logger.error("$TAG: atualização falhou", e)
                UpdaterBus.emit("failed") { it.put("message", e.message ?: e.toString()) }
                cacheDir(ctx).deleteRecursively()
            } finally {
                busy = false
            }
        }, "rustify-updater").start()
        return true
    }

    // ---------------------------------------------------------------- interno

    private fun cacheDir(ctx: Context) = File(ctx.cacheDir, "updates")

    /**
     * Segue redirects manualmente (o GitHub responde 302 para
     * objects.githubusercontent.com); o HttpURLConnection só segue sozinho
     * quando o esquema não muda, e aqui não confiamos nisso.
     */
    private fun open(url: String, userAgent: String): HttpURLConnection {
        var current = url
        repeat(MAX_REDIRECTS) {
            val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", userAgent)
                setRequestProperty("Accept", "*/*")
            }
            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location")
                    ?: throw IllegalStateException("redirect $code sem Location")
                conn.disconnect()
                current = URL(URL(current), loc).toString()
            } else {
                return conn
            }
        }
        throw IllegalStateException("redirects demais a partir de $url")
    }

    private fun download(
        ctx: Context,
        url: String,
        expectedSha: String?,
        expectedSize: Long,
        userAgent: String,
    ): File {
        val dir = cacheDir(ctx)
        dir.deleteRecursively()
        dir.mkdirs()
        val out = File(dir, "update.apk")
        val conn = open(url, userAgent)
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code ao baixar o APK")
            val total = if (expectedSize > 0) expectedSize else conn.contentLengthLong
            val digest = MessageDigest.getInstance("SHA-256")
            var bytes = 0L
            var lastEmit = 0L
            var lastPct = -1
            UpdaterBus.emit("downloading") { it.put("bytes", 0L); it.put("total", total) }
            conn.inputStream.use { inp ->
                FileOutputStream(out).use { fos ->
                    val buf = ByteArray(BUF)
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        fos.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        bytes += n
                        val now = System.currentTimeMillis()
                        val pct = if (total > 0) ((bytes * 100) / total).toInt() else -1
                        if (pct != lastPct && now - lastEmit >= 250) {
                            lastEmit = now
                            lastPct = pct
                            UpdaterBus.emit("downloading") { it.put("bytes", bytes); it.put("total", total) }
                        }
                    }
                    fos.fd.sync()
                }
            }
            UpdaterBus.emit("verifying")
            if (expectedSize > 0 && bytes != expectedSize) {
                throw IllegalStateException("tamanho divergente: $bytes != $expectedSize")
            }
            val sha = digest.digest().joinToString("") { "%02x".format(it) }
            if (expectedSha != null && !sha.equals(expectedSha, ignoreCase = true)) {
                throw IllegalStateException("sha256 divergente do manifest")
            }
            return out
        } finally {
            conn.disconnect()
        }
    }

    private fun install(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        params.setSize(apk.length())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            params.setInstallReason(PackageManager.INSTALL_REASON_USER)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("update.apk", 0, apk.length()).use { out ->
                FileInputStream(apk).use { it.copyTo(out, BUF) }
                session.fsync(out)
            }
            UpdaterBus.emit("installing")
            // Intent EXPLÍCITO + FLAG_MUTABLE: o instalador preenche os extras
            // de status no próprio intent (Android 12+ exige declarar a
            // mutabilidade; 14+ recusa mutável implícito).
            val intent = Intent(ctx, UpdateInstallReceiver::class.java)
                .setAction(INSTALL_STATUS_ACTION)
                .setPackage(ctx.packageName)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
            val pi = PendingIntent.getBroadcast(ctx, sessionId, intent, flags)
            session.commit(pi.intentSender)
        }
    }
}
```

- [ ] **Step 4: `UpdateInstallReceiver.kt`**

```kotlin
package app.tauri.rustifyaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import app.tauri.Logger

/**
 * Destino do `commit` da sessão do PackageInstaller (declarado no manifest do
 * plugin). O contrato do Android: em `STATUS_PENDING_USER_ACTION` o app DEVE
 * iniciar o intent em `EXTRA_INTENT` — é a tela de confirmação do sistema.
 * Sucesso mata e reinicia o processo; `done` raramente chega ao JS.
 */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = confirmIntent(intent)
                if (confirm == null) {
                    UpdaterBus.emit("failed") { it.put("message", "sistema não devolveu a tela de confirmação") }
                    return
                }
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    context.startActivity(confirm)
                    UpdaterBus.emit("confirming")
                } catch (e: Exception) {
                    Logger.error("RustifyUpdater: não abriu a confirmação", e)
                    UpdaterBus.emit("failed") { it.put("message", e.message ?: "não abriu a confirmação") }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> UpdaterBus.emit("done")
            else -> UpdaterBus.emit("failed") {
                it.put("message", message ?: "instalação recusada (status $status)")
            }
        }
    }

    private fun confirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
}
```

- [ ] **Step 5: `AndroidManifest.xml` do plugin** — adicionar a permissão junto das outras e o receiver dentro de `<application>`:

```xml
    <!-- Auto-update: PackageInstaller de sideload exige este toggle por app. -->
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

```xml
        <!-- Status da sessão do PackageInstaller (auto-update). -->
        <receiver
            android:name="app.tauri.rustifyaudio.UpdateInstallReceiver"
            android:exported="false" />
```

- [ ] **Step 6: `AudioPlugin.kt`** — (a) args, após `class AckEventsArgs`:

```kotlin
@InvokeArg
class UpdaterCheckArgs {
    /** Override para teste; `null` usa [UPDATE_MANIFEST_URL]. */
    var manifestUrl: String? = null
}

@InvokeArg
class UpdaterInstallArgs {
    lateinit var url: String
    var sha256: String? = null
    var size: Long = 0L
}
```

(b) a classe passa a implementar também `UpdaterBus.Sink`:

```kotlin
class AudioPlugin(private val activity: Activity) : Plugin(activity), PlaybackBus.Sink,
    SpectrumBus.Sink, UpdaterBus.Sink {
```

(c) em `load`, adicionar `UpdaterBus.sink = this`; em `onDestroy`, antes de `releaseController()`:

```kotlin
        if (UpdaterBus.sink === this) {
            UpdaterBus.sink = null
        }
```

(d) commands, após `ackEvents`:

```kotlin
    // ------------------------------------------------------------ atualização

    private fun userAgent(): String =
        "rustify-player-android/${Updater.installedVersion(activity.applicationContext)}"

    /** Consulta o manifest do release (thread própria; resolve na main). */
    @Command
    fun updaterCheck(invoke: Invoke) {
        val args = invoke.parseArgs(UpdaterCheckArgs::class.java)
        val url = args.manifestUrl?.takeIf { it.isNotBlank() } ?: UPDATE_MANIFEST_URL
        val ctx = activity.applicationContext
        val ua = userAgent()
        Thread({
            try {
                val m = Updater.fetchManifest(url, ua)
                val installed = Updater.installedVersion(ctx)
                val payload = JSObject()
                payload.put("installed", installed)
                payload.put("latest", m.version)
                payload.put("available", Semver.compare(m.version, installed) > 0)
                payload.put("apkUrl", m.apkUrl)
                payload.put("sha256", m.sha256 ?: JSONObject.NULL)
                payload.put("size", m.size)
                payload.put("canInstall", Updater.canInstall(ctx))
                activity.runOnUiThread { invoke.resolve(payload) }
            } catch (e: Exception) {
                Logger.error("rustify-audio: updater_check falhou", e)
                activity.runOnUiThread { invoke.reject(e.message ?: "falha ao consultar atualização") }
            }
        }, "rustify-updater-check").start()
    }

    /**
     * Baixa e instala. Resolve NA HORA com `started`/`busy`/`needs_permission`;
     * o progresso vai pelo evento [EVENT_UPDATER_PROGRESS] — a promise do JS
     * não sobrevive a um reload do WebView, o evento é reassinável.
     */
    @Command
    fun updaterInstall(invoke: Invoke) {
        val args = invoke.parseArgs(UpdaterInstallArgs::class.java)
        val ctx = activity.applicationContext
        val payload = JSObject()
        if (!Updater.canInstall(ctx)) {
            Updater.openInstallPermissionSettings(activity)
            payload.put("status", "needs_permission")
            invoke.resolve(payload)
            return
        }
        val started = Updater.startDownloadAndInstall(ctx, args.url, args.sha256, args.size, userAgent())
        payload.put("status", if (started) "started" else "busy")
        invoke.resolve(payload)
    }
```

(e) sink, após `onFft`:

```kotlin
    /** Progresso do updater (thread do download / receiver) -> evento. */
    override fun onUpdaterEvent(payload: JSObject) {
        if (!hasListener(EVENT_UPDATER_PROGRESS)) return
        trigger(EVENT_UPDATER_PROGRESS, payload)
    }
```

- [ ] **Step 7: Rodar o teste JVM**

Run: `cd /home/opc/rustify-player/src-tauri/gen/android && ./gradlew :tauri-plugin-rustify-audio:testDebugUnitTest -q 2>&1 | tail -15`
Expected: BUILD SUCCESSFUL (4 testes). Se falhar por ambiente (não por código), anotar o erro e seguir — a Task 6 repete.

- [ ] **Step 8: Commit**

```bash
cd /home/opc/rustify-player
git add src-tauri/crates/tauri-plugin-rustify-audio/android
git commit -m "feat(android): updater Kotlin — manifest, download+sha256, PackageInstaller, receiver

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — tipos, IPC, estado, Settings, boot check

**Files:**
- Modify: `src/mobile/types.ts` (fim)
- Modify: `src/mobile/ipc.ts` (seção nova antes de `// ── Arquivos locais`)
- Create: `src/mobile/updater.ts`, `src/mobile/updater.test.ts`
- Modify: `src/mobile/screens/Settings.tsx` (painel novo entre "Library" e "About"; comentário do cabeçalho)
- Modify: `src/mobile/MobileApp.tsx` (`mountMobile`, após `void bootStore();`)
- Modify: `src/mobile/styles/app.css` (após o bloco `.selbtn:disabled`)

**Interfaces:**
- Consumes: `plugin:rustify-audio|updater_check`, `plugin:rustify-audio|updater_install`, evento `updater_progress` (Task 2), command `app_version` (Task 1).

- [ ] **Step 1: Tipos em `types.ts`** — anexar ao fim:

```ts
/** Resposta de `updater_check` (decisão `available` é do Kotlin). */
export interface UpdateCheck {
  installed: string;
  latest: string;
  available: boolean;
  apkUrl: string | null;
  sha256: string | null;
  size: number;
  /** false = falta o toggle "instalar apps desconhecidos" para o app. */
  canInstall: boolean;
}

export type UpdaterPhase =
  | "downloading"
  | "verifying"
  | "installing"
  | "confirming"
  | "done"
  | "failed";

/** Evento `updater_progress` do plugin. */
export interface UpdaterProgress {
  phase: UpdaterPhase;
  bytes?: number;
  total?: number;
  message?: string;
}
```

- [ ] **Step 2: IPC em `ipc.ts`** — importar `UpdateCheck, UpdaterProgress` no `import type` e adicionar antes de `// ── Arquivos locais`:

```ts
// ── Atualização (spec 2026-08-24-android-auto-update) ─────────
// HTTP e instalação vivem no Kotlin (TLS da plataforma). A UI só pede o
// check, dispara o install e escuta o progresso.

export const appVersion = () => invoke<string>("app_version");
export const updaterCheck = (manifestUrl?: string) =>
  invoke<UpdateCheck>(cmd("updater_check"), { manifestUrl: manifestUrl ?? null });
export const updaterInstall = (args: { url: string; sha256: string | null; size: number }) =>
  invoke<{ status: "started" | "needs_permission" | "busy" }>(
    cmd("updater_install"),
    args as unknown as Record<string, unknown>,
  );
export const onUpdaterProgress = (cb: (p: UpdaterProgress) => void) =>
  addPluginListener(PLUGIN, "updater_progress", cb as (payload: unknown) => void).then(
    (h) => () => h.unregister(),
  );
```

- [ ] **Step 3: Teste `updater.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { bootCheckDue, fmtBytes, reduceProgress, type UpdState } from "./updater";

const base: UpdState = {
  phase: "available",
  check: {
    installed: "0.2.75",
    latest: "0.2.76",
    available: true,
    apkUrl: "https://x/a.apk",
    sha256: null,
    size: 100,
    canInstall: true,
  },
  bytes: 0,
  total: 0,
  error: null,
};

describe("reduceProgress", () => {
  it("downloading atualiza bytes/total e limpa erro", () => {
    const s = reduceProgress({ ...base, error: "x" }, { phase: "downloading", bytes: 40, total: 100 });
    expect(s.phase).toBe("downloading");
    expect(s.bytes).toBe(40);
    expect(s.total).toBe(100);
    expect(s.error).toBeNull();
  });

  it("failed guarda a mensagem e mantém o check para re-tentar", () => {
    const s = reduceProgress(base, { phase: "failed", message: "sha256 divergente" });
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("sha256 divergente");
    expect(s.check).toEqual(base.check);
  });

  it("verifying/installing/confirming/done trocam só a fase", () => {
    for (const phase of ["verifying", "installing", "confirming", "done"] as const) {
      expect(reduceProgress(base, { phase }).phase).toBe(phase);
    }
  });
});

describe("bootCheckDue", () => {
  const H = 3_600_000;
  it("sem registro anterior, deve checar", () => {
    expect(bootCheckDue(null, 10 * H)).toBe(true);
  });
  it("dentro de 6h não checa; depois de 6h checa", () => {
    expect(bootCheckDue(String(4 * H), 9 * H)).toBe(false);
    expect(bootCheckDue(String(4 * H), 10 * H + 1)).toBe(true);
  });
  it("valor corrompido conta como nunca checou", () => {
    expect(bootCheckDue("abc", 10 * H)).toBe(true);
  });
});

describe("fmtBytes", () => {
  it("formata MB com uma casa", () => {
    expect(fmtBytes(27_702_872)).toBe("26,4 MB");
    expect(fmtBytes(0)).toBe("0 MB");
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `cd /home/opc/rustify-player && npx vitest run src/mobile/updater.test.ts 2>&1 | tail -8`
Expected: falha (módulo `./updater` não existe).

- [ ] **Step 5: `updater.ts`**

```ts
/* ============================================================
   updater.ts — estado do auto-update (spec 2026-08-24).

   O trabalho (HTTP, sha256, PackageInstaller) é do Kotlin. Aqui só
   vive o estado da UI: resultado do check, progresso do download e
   o throttle do check automático de boot. Sideload nunca é
   silencioso — o sistema pede confirmação; "done" raramente chega
   porque a instalação reinicia o processo.
   ============================================================ */

import { createSignal } from "solid-js";
import * as ipc from "./ipc";
import { showToast } from "./store";
import type { UpdateCheck, UpdaterProgress } from "./types";

export type UpdPhase =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "needs_permission"
  | "downloading"
  | "verifying"
  | "installing"
  | "confirming"
  | "done"
  | "failed";

export interface UpdState {
  phase: UpdPhase;
  check: UpdateCheck | null;
  bytes: number;
  total: number;
  error: string | null;
}

const CHECK_KEY = "kv-mobile-upd-check";
/** Check automático no máximo a cada 6h (spec). */
export const BOOT_THROTTLE_MS = 6 * 3_600_000;

const [upd, setUpd] = createSignal<UpdState>({
  phase: "idle",
  check: null,
  bytes: 0,
  total: 0,
  error: null,
});
const [appVersion, setAppVersion] = createSignal<string>("");
export { upd, appVersion };

/** Puro: evento do plugin -> estado novo. */
export function reduceProgress(s: UpdState, ev: UpdaterProgress): UpdState {
  switch (ev.phase) {
    case "downloading":
      return { ...s, phase: "downloading", bytes: ev.bytes ?? s.bytes, total: ev.total ?? s.total, error: null };
    case "failed":
      return { ...s, phase: "failed", error: ev.message ?? "falha desconhecida" };
    default:
      return { ...s, phase: ev.phase, error: null };
  }
}

/** Puro: `last` é o epoch-ms salvo (string) ou null. */
export function bootCheckDue(last: string | null, nowMs: number, throttleMs = BOOT_THROTTLE_MS): boolean {
  if (!last) return true;
  const t = Number(last);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= throttleMs;
}

export function fmtBytes(n: number): string {
  const mb = n / 1_048_576;
  return `${mb.toLocaleString("pt-BR", { minimumFractionDigits: mb ? 1 : 0, maximumFractionDigits: 1 })} MB`;
}

export const updBusy = () =>
  ["checking", "downloading", "verifying", "installing", "confirming"].includes(upd().phase);

export async function loadAppVersion() {
  try {
    setAppVersion(await ipc.appVersion());
  } catch (e) {
    console.warn("[mobile] app_version falhou:", e);
  }
}

/**
 * `manual=true` (botão): erro vira toast. `manual=false` (boot): silencioso,
 * só o log — sem rede no boot não é notícia.
 */
export async function checkForUpdate(manual: boolean): Promise<void> {
  if (updBusy()) return;
  setUpd((s) => ({ ...s, phase: "checking", error: null }));
  try {
    const check = await ipc.updaterCheck();
    localStorage.setItem(CHECK_KEY, String(Date.now()));
    if (check.installed) setAppVersion(check.installed);
    setUpd({ phase: check.available ? "available" : "uptodate", check, bytes: 0, total: 0, error: null });
    if (check.available && !manual) showToast(`Atualização ${check.latest} disponível — veja em Settings`);
    if (!check.available && manual) showToast("Você já está na versão mais recente");
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.warn("[mobile] updater_check falhou:", msg);
    setUpd((s) => ({ ...s, phase: s.check ? "available" : "idle", error: manual ? msg : null }));
    if (manual) showToast("Não deu para consultar o release");
  }
}

export async function installUpdate(): Promise<void> {
  const s = upd();
  const check = s.check;
  if (!check?.apkUrl || updBusy()) return;
  setUpd((x) => ({ ...x, phase: "downloading", bytes: 0, total: check.size, error: null }));
  try {
    const r = await ipc.updaterInstall({ url: check.apkUrl, sha256: check.sha256, size: check.size });
    if (r.status === "needs_permission") {
      setUpd((x) => ({ ...x, phase: "needs_permission" }));
      showToast("Libere 'instalar apps desconhecidos' e toque de novo");
    } else if (r.status === "busy") {
      setUpd((x) => ({ ...x, phase: "downloading" }));
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    setUpd((x) => ({ ...x, phase: "failed", error: msg }));
  }
}

/** Boot: versão instalada + listener de progresso + check com throttle. */
export function bootUpdater(): void {
  void loadAppVersion();
  ipc
    .onUpdaterProgress((ev) => setUpd((s) => reduceProgress(s, ev)))
    .catch((e) => console.warn("[mobile] listener updater_progress:", e));
  if (bootCheckDue(localStorage.getItem(CHECK_KEY), Date.now())) {
    // Depois do boot pesado (biblioteca, fila): nada disso é urgente.
    setTimeout(() => void checkForUpdate(false), 4000);
  }
}
```

- [ ] **Step 6: Rodar os testes**

Run: `cd /home/opc/rustify-player && npx vitest run src/mobile/updater.test.ts 2>&1 | tail -8`
Expected: 7 testes passando.

- [ ] **Step 7: Settings — painel "Atualização"** — em `Settings.tsx`: importar `Show` já está; adicionar imports:

```ts
import { appVersion, checkForUpdate, fmtBytes, installUpdate, upd, updBusy } from "../updater";
```

Inserir o painel entre o `setpanel` "Library" e o "About":

```tsx
      <div class="setpanel">
        <div class="setpanel__head">
          <div class="setpanel__title">Atualização</div>
          <span class="setpanel__sub">
            <Show when={appVersion()} fallback="versão —">
              v{appVersion()}
            </Show>
          </span>
        </div>
        <div class="setrow setrow--inline">
          <div>
            <div class="setrow__label">{updLabel()}</div>
            <div class="setrow__hint">{updHint()}</div>
          </div>
          <button
            class="selbtn selbtn--accent"
            style={{ width: "auto" }}
            disabled={updBusy()}
            onClick={() => void updAction()}
          >
            {updButton()}
          </button>
        </div>
        <Show when={upd().phase === "downloading" && upd().total > 0}>
          <div class="setrow">
            <div class="updbar">
              <i style={{ width: `${Math.min(100, (100 * upd().bytes) / upd().total)}%` }} />
            </div>
          </div>
        </Show>
      </div>
```

e, dentro de `Settings()` antes do `return`, os derivados:

```tsx
  const updLabel = () => {
    const s = upd();
    switch (s.phase) {
      case "checking":
        return "Consultando o release…";
      case "available":
      case "needs_permission":
        return `Versão ${s.check?.latest} disponível`;
      case "downloading":
        return `Baixando ${fmtBytes(s.bytes)}${s.total ? ` de ${fmtBytes(s.total)}` : ""}`;
      case "verifying":
        return "Verificando o pacote…";
      case "installing":
        return "Preparando a instalação…";
      case "confirming":
        return "Confirme a instalação na tela do sistema";
      case "done":
        return "Instalada — o app vai reabrir";
      case "failed":
        return "A atualização falhou";
      case "uptodate":
        return "Você está na versão mais recente";
      default:
        return "Buscar atualização";
    }
  };
  const updHint = () => {
    const s = upd();
    if (s.phase === "failed") return s.error ?? "erro desconhecido";
    if (s.phase === "needs_permission")
      return "O Android exige liberar 'instalar apps desconhecidos' para o Rustify uma vez. Volte e toque de novo.";
    if (s.phase === "available" && s.check)
      return `${fmtBytes(s.check.size)} · do release dev no GitHub · a instalação pede confirmação do sistema.`;
    return "Consulta o release dev no GitHub. O check automático roda no máximo a cada 6h.";
  };
  const updButton = () => {
    const p = upd().phase;
    if (p === "available" || p === "needs_permission") return "Baixar e instalar";
    if (p === "failed") return "Tentar de novo";
    if (p === "downloading" || p === "verifying" || p === "installing" || p === "confirming") return "…";
    return "Buscar";
  };
  const updAction = () => {
    const p = upd().phase;
    if (p === "available" || p === "needs_permission") return installUpdate();
    if (p === "failed" && upd().check?.available) return installUpdate();
    return checkForUpdate(true);
  };
```

Atualizar o comentário do cabeçalho do arquivo: remover "check for updates" da lista do que "saiu" e acrescentar a linha `Entrou (26/08): Atualização — check no release dev + download + PackageInstaller (spec 2026-08-24).`

- [ ] **Step 8: Boot em `MobileApp.tsx`** — importar `import { bootUpdater } from "./updater";` e, em `mountMobile`, logo após `void bootStore();`:

```ts
  // Versão instalada + check de atualização com throttle (spec 2026-08-24).
  bootUpdater();
```

- [ ] **Step 9: CSS** — em `app.css`, após `.selbtn:disabled { ... }`:

```css
/* Barra de progresso do updater (Settings > Atualização). */
.updbar {
  height: 4px;
  border-radius: 2px;
  background: var(--div-subtle);
  position: relative;
  overflow: hidden;
}
.updbar i {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--accent);
  width: 0;
  transition: width 200ms linear;
}
```

- [ ] **Step 10: typecheck + suíte**

Run: `cd /home/opc/rustify-player && npm run typecheck 2>&1 | tail -5 && npx vitest run 2>&1 | tail -6`
Expected: typecheck limpo; todos os testes passando (mobile inclusive).

- [ ] **Step 11: Commit**

```bash
cd /home/opc/rustify-player
git add src/mobile
git commit -m "feat(android): seção Atualização na Settings + check de boot com throttle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `scripts/release_android.sh`

**Files:**
- Create: `scripts/release_android.sh` (chmod +x)

**Interfaces:**
- Produces: assets `rustify-player_<versão>.apk` e `android-latest.json` (`{version, apk_url, sha256, size}`) no release `dev`. O Kotlin (Task 2) lê exatamente essas chaves.

- [ ] **Step 1: Escrever o script**

```bash
#!/usr/bin/env bash
# Build do APK Android na VM e publicação no release rolling "dev" junto com
# o manifest `android-latest.json` que o app consulta para se auto-atualizar
# (spec docs/superpowers/specs/2026-08-24-android-auto-update-design.md).
#
#   ./scripts/release_android.sh            # build + upload
#   ./scripts/release_android.sh --dry-run  # build + manifest, sem upload
#
# NAO bumpa versao: bump manual em src-tauri/tauri.conf.json ANTES (o APK
# carimba versionName/versionCode a partir dela; sem bump o aparelho nao ve
# atualizacao — e o asset da versao anterior seria sobrescrito).
#
# APK = debug, so arm64 (o S24 e arm64), sem debuginfo no .so
# (CARGO_PROFILE_DEV_STRIP): 520 MB (universal, com DWARF) -> ~50 MB.
# Assinatura: ~/.android/debug.keystore da VM (backup em cmr-auto:~/backups).
# Trocar de keystore quebra o update por cima (assinatura divergente).

set -euo pipefail

cd "$(dirname "$0")/.."

REPO="PedroGiudice/rustify-player"
TAG="dev"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

for t in gh jq sha256sum bun cargo python3; do
  command -v "$t" >/dev/null 2>&1 || { echo "[android] falta $t"; exit 2; }
done

VERSION="$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
APK_NAME="rustify-player_${VERSION}.apk"
OUT="src-tauri/target/android-release"
APK_OUT_DIR="src-tauri/gen/android/app/build/outputs/apk"
mkdir -p "$OUT"

echo "[android] frontend (obrigatorio: o dist e embutido no .so)"
bun run build

echo "[android] apk v${VERSION} (arm64, debug, strip=debuginfo)"
# Limpa saidas antigas: sem isso um APK velho poderia ser escolhido abaixo.
rm -rf "$APK_OUT_DIR"
(
  cd src-tauri
  CARGO_PROFILE_DEV_STRIP=debuginfo cargo tauri android build --debug --target aarch64 --apk
)

SRC="$(find "$APK_OUT_DIR" -name '*.apk' -path '*debug*' | head -n 1)"
test -n "$SRC" -a -f "$SRC" || { echo "[android] nenhum APK em $APK_OUT_DIR"; exit 1; }

# Versao carimbada no APK precisa ser a do tauri.conf.json (o tauri.properties
# e regenerado no build; se divergir, algo ficou stale).
BUILT_VER="$(sed -n 's/^tauri.android.versionName=//p' src-tauri/gen/android/app/tauri.properties)"
if [[ "$BUILT_VER" != "$VERSION" ]]; then
  echo "[android] versionName do build ($BUILT_VER) != tauri.conf.json ($VERSION)"; exit 1
fi

cp "$SRC" "$OUT/$APK_NAME"
SHA="$(sha256sum "$OUT/$APK_NAME" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$OUT/$APK_NAME")"
jq -n \
  --arg v "$VERSION" \
  --arg u "https://github.com/${REPO}/releases/download/${TAG}/${APK_NAME}" \
  --arg s "$SHA" \
  --argjson z "$SIZE" \
  '{version: $v, apk_url: $u, sha256: $s, size: $z}' > "$OUT/android-latest.json"

echo "[android] $APK_NAME  $((SIZE / 1048576)) MB  sha256=$SHA"
cat "$OUT/android-latest.json"

if [[ "$DRY" == "1" ]]; then
  echo "[android] dry-run: nada publicado"
  exit 0
fi

gh release view "$TAG" -R "$REPO" >/dev/null 2>&1 || { echo "[android] release $TAG nao existe (rode release.sh primeiro)"; exit 1; }
echo "[android] upload -> $REPO@$TAG"
gh release upload "$TAG" "$OUT/$APK_NAME" "$OUT/android-latest.json" -R "$REPO" --clobber
echo "[android] publicado. O aparelho ve a versao no proximo check (Settings > Atualizacao)."
```

- [ ] **Step 2: Sintaxe e permissão**

Run: `cd /home/opc/rustify-player && chmod +x scripts/release_android.sh && bash -n scripts/release_android.sh && echo SYNTAX_OK`
Expected: `SYNTAX_OK`.

- [ ] **Step 3: Commit** (o `--dry-run` real roda na Task 6, uma vez)

```bash
cd /home/opc/rustify-player
git add scripts/release_android.sh
git commit -m "feat(android): release_android.sh — APK arm64 stripado + android-latest.json no release dev

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Documentação viva

**Files:**
- Modify: `CLAUDE.md` (seção "Android (v0 …)" → subseção "Build, install e debug")
- Modify: `docs/android/ipc-contrato-v0.md` (nova seção antes de "## Origins"; e a lista "O que NÃO existe")
- Modify: `src-tauri/crates/tauri-plugin-rustify-audio/README.md` (tabela do contrato + seção Eventos)

- [ ] **Step 1: CLAUDE.md** — no bloco de comandos da subseção "Build, install e debug", substituir o bloco ```bash``` inteiro e o bullet "Distribuicao v0 = APK debug-signed via adb (sem loja, sem updater)." por:

````markdown
```bash
# Release Android (VM): bun run build + APK debug arm64 SEM debuginfo
# (~50 MB; o universal com DWARF tinha 520 MB) + android-latest.json,
# publicados no release `dev`. Bump em tauri.conf.json ANTES.
./scripts/release_android.sh            # ou --dry-run (sem upload)
# Primeira instalacao (ou troca de keystore) continua via adb:
scp src-tauri/target/android-release/rustify-player_<V>.apk cmr-auto@100.102.249.9:/tmp/ && \
  ssh cmr-auto@100.102.249.9 'adb install -r /tmp/rustify-player_<V>.apk'
# Permissao de acervo (uma vez por install limpo):
ssh cmr-auto@100.102.249.9 'adb shell appops set dev.cmr.rustifyplayer MANAGE_EXTERNAL_STORAGE allow'
```

- **Auto-update (v0.2.76, spec `docs/superpowers/specs/2026-08-24-android-auto-update-design.md`)**:
  o app consulta `android-latest.json` do release `dev` (check no boot com
  throttle de 6h + botão em Settings > Atualização), baixa o APK pelo Kotlin
  (TLS da plataforma — o ureq do Android é sem TLS), confere sha256 e commita
  uma `PackageInstaller.Session`; o sistema pede confirmação (sideload nunca é
  silencioso). Exige o toggle "instalar apps desconhecidos" uma vez. O
  `versionCode` deriva da semver (0.2.74 → 2074): só sobe com bump.
  **Assinatura = debug keystore da VM** (`~/.android/debug.keystore`, backup
  em `cmr-auto:~/backups/rustify-debug.keystore`): trocar o keystore quebra o
  update por cima e obriga reinstalar via adb.
````

- [ ] **Step 2: `docs/android/ipc-contrato-v0.md`** — inserir antes de `## Origins`:

````markdown
## Atualização (plugin rustify-audio — desde v0.2.76)

```ts
const v = await invoke('app_version')                     // "0.2.76" (offline)
const c = await invoke('plugin:rustify-audio|updater_check', { manifestUrl: null })
// { installed, latest, available, apkUrl, sha256, size, canInstall }
// rejeita sem rede / manifest inválido — no boot é silencioso, no botão vira toast
const r = await invoke('plugin:rustify-audio|updater_install',
  { url: c.apkUrl, sha256: c.sha256, size: c.size })
// { status: 'started' | 'needs_permission' | 'busy' }
// needs_permission: o Kotlin já abriu a tela do sistema; re-tocar depois.
// progresso: addPluginListener('rustify-audio', 'updater_progress', ev)
// ev = { phase: 'downloading'|'verifying'|'installing'|'confirming'|'done'|'failed',
//        bytes?, total?, message? }
```

A decisão `available` é do Kotlin (semver contra o `versionName` instalado).
"done" raramente chega: a instalação reinicia o processo.
````

e na seção "O que NÃO existe", nenhuma menção a update precisa ser removida (não há); acrescentar ao parágrafo "Já entregue depois da v0": `auto-update (26/08, spec 2026-08-24 — updater_check/updater_install + Settings > Atualização).`

- [ ] **Step 3: README do plugin** — na tabela do contrato, após a linha `ack_events`:

```markdown
| `updater_check` | `manifestUrl?` | `{ installed, latest, available, apkUrl, sha256, size, canInstall }` |
| `updater_install` | `url`, `sha256?`, `size?` | `{ status: 'started'\|'needs_permission'\|'busy' }` |
```

e na seção `## Eventos (best-effort)` acrescentar:

```markdown
- `updater_progress` — `{ phase, bytes?, total?, message? }`, `phase` ∈
  `downloading | verifying | installing | confirming | done | failed`. Emitido
  pela thread do download e pelo `UpdateInstallReceiver` (status do
  PackageInstaller). Exige `REQUEST_INSTALL_PACKAGES` (manifest do plugin) e o
  toggle "instalar apps desconhecidos" concedido pelo usuário.
```

- [ ] **Step 4: Commit**

```bash
cd /home/opc/rustify-player
git add CLAUDE.md docs/android/ipc-contrato-v0.md src-tauri/crates/tauri-plugin-rustify-audio/README.md
git commit -m "docs(android): auto-update — fluxo de release, contrato IPC e README do plugin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Gates, build único, bump e publicação (coordenador)

**Files:**
- Modify: `src-tauri/tauri.conf.json` (`version` → `0.2.76`)

- [ ] **Step 1: Gates no host** — `cd src-tauri && cargo test -p tauri-plugin-rustify-audio` · `cargo check` (desktop, garante que `mobile.rs` do app não quebrou nada cross) · `npm run typecheck` · `npx vitest run`.
- [ ] **Step 2: Bump** — `sed -i 's/"version": "0.2.75"/"version": "0.2.76"/' src-tauri/tauri.conf.json` e commit `chore: bump 0.2.76`.
- [ ] **Step 3: Build único** — `./scripts/release_android.sh --dry-run`. Verificar: APK ≤ 80 MB, `versionName=0.2.76` no `tauri.properties`, `android-latest.json` coerente, `unzip -l` mostra só `lib/arm64-v8a/`.
- [ ] **Step 4: Teste JVM** — `cd src-tauri/gen/android && ./gradlew :tauri-plugin-rustify-audio:testDebugUnitTest -q` (o build acabou de regenerar os arquivos do Tauri).
- [ ] **Step 5: Manifest mergeado** — `$ANDROID_HOME/build-tools/35.0.0/aapt2 dump permissions <apk>` deve listar `android.permission.REQUEST_INSTALL_PACKAGES`; `aapt2 dump xmltree --file AndroidManifest.xml <apk> | grep -A2 receiver` deve mostrar `UpdateInstallReceiver`.
- [ ] **Step 6: Publicar** — `./scripts/release_android.sh` (sem dry-run). Conferir `gh release view dev --json assets -q '.assets[].name' | grep -E 'apk|android-latest'` e `curl -sL <manifest url> | jq .`.
- [ ] **Step 7: Commit dos autogenerados** que sobraram (`permissions/autogenerated`, `gen/android` se algo tracked mudou) e push.
- [ ] **Step 8: E2E no aparelho (pendente até o S24 estar na cmr-auto)** — instalar o APK 0.2.76 via adb (primeira vez com o updater), depois publicar 0.2.77 pela VM, abrir o app → toast/Settings → Baixar e instalar → toggle do sistema → confirmação → app reabre em 0.2.77 e `device.json`/journal intactos.

---

## Self-review

**Cobertura da spec:** publicação (Task 4), plugin Kotlin com 2 commands + permissão + receiver (Task 2), lado Rust + permissões (Task 1), UI Settings + boot throttle 6h + toast (Task 3), tratamento de erro (Task 2 `failed` + Task 3 `checkForUpdate`/`installUpdate`), sha256 + size (Task 2/4), dry-run (Task 4), E2E manual (Task 6 §8), keystore backup (feito na sessão; documentado na Task 5), APK enxuto (Task 4/6). 

**Consistência de nomes:** `updaterCheck`/`updaterInstall` (Kotlin) ↔ `updater_check`/`updater_install` (Rust/JS); evento `updater_progress` ↔ `EVENT_UPDATER_PROGRESS` ↔ `onUpdaterProgress`; chaves do manifest `version/apk_url/sha256/size` iguais no script e no `UpdateManifest.parse`; `status` ∈ `started|needs_permission|busy` nos três lados; `UpdateCheck.canInstall` ↔ `canInstall` no JSObject.
