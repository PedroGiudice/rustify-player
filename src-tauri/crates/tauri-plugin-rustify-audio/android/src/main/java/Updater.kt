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

        /** Activity em RESUMED agora? Consultado pelo receiver NA HORA do
         *  broadcast — só nesse estado o launch da confirmação passa. */
        fun isResumed(): Boolean
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
 * Confirmação diferida. No Android 14+ o `STATUS_PENDING_USER_ACTION` chega
 * com background-activity-launch NEGADO (PackageInstallerSession.
 * sendOnUserActionRequired: setPendingIntentBackgroundActivityLaunchAllowed
 * (false)); um `startActivity` do receiver com o app invisível (tela apagada
 * ou outro app na frente durante o download) é descartado EM SILÊNCIO — sem
 * exceção, só "Background activity launch blocked!" no logcat. O intent fica
 * aqui e o plugin o dispara no `onResume`, quando o launch é foreground.
 */
object PendingConfirm {
    @Volatile
    var intent: Intent? = null
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
        // Sessão anterior abandonada (usuário saiu da confirmação): o sistema
        // não a fecha sozinho; sem isto cada retry deixa uma sessão órfã.
        for (old in installer.mySessions) {
            try {
                installer.abandonSession(old.sessionId)
            } catch (e: Exception) {
                // já fechada/abandonada
            }
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
