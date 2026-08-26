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
