package app.tauri.rustifyaudio

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * Journal append-only de eventos de escuta — a razao de ser do plugin.
 *
 * Quem grava e o service, sempre: com a tela apagada o WebView esta suspenso e
 * qualquer caminho que passe pelo JS perde evento. O JS so consome, por [drain]
 * (a partir de um `seq`) e [ack] (marca d'agua + compactacao).
 *
 * O arquivo e `filesDir/play_events.jsonl`, uma linha JSON por transicao de
 * faixa, com fsync por escrita.
 */
object EventJournal {
    private const val TAG = "RustifyAudioJournal"
    private const val FILE_NAME = "play_events.jsonl"
    private const val TMP_NAME = "play_events.jsonl.tmp"
    private const val PREFS = "rustify_audio_journal"
    private const val KEY_SEQ = "last_seq"
    private const val KEY_ACK = "ack_seq"

    private val lock = Any()
    private var seq: Long = -1L

    data class DrainResult(val events: JSONArray, val lastSeq: Long)

    private fun file(ctx: Context) = File(ctx.filesDir, FILE_NAME)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun seqOf(line: String): Long {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return -1L
        return try {
            JSONObject(trimmed).optLong("seq", -1L)
        } catch (e: Exception) {
            -1L
        }
    }

    private fun ensureSeq(ctx: Context) {
        if (seq >= 0L) return
        var max = prefs(ctx).getLong(KEY_SEQ, 0L)
        // O arquivo e a verdade se o prefs regrediu (crash entre o fsync da
        // linha e o commit do contador). Varredura so acontece uma vez por
        // processo, e o ack mantem o arquivo curto.
        val f = file(ctx)
        if (f.exists()) {
            try {
                f.forEachLine { line ->
                    val s = seqOf(line)
                    if (s > max) max = s
                }
            } catch (e: Exception) {
                Log.e(TAG, "falha lendo journal para recuperar seq", e)
            }
        }
        seq = max
    }

    /** Appenda um evento e devolve o `seq` gravado (-1 em falha de IO). */
    fun append(
        ctx: Context,
        eventType: String,
        trackId: String,
        origin: String,
        contextId: String?,
        startedAt: Long,
        timestamp: Long,
        endPositionMs: Long,
        durationMs: Long,
        /** Pulo PARA TRAS (replay). Nao e rejeicao — a reacao de sessao ignora. */
        backward: Boolean = false
    ): Long {
        synchronized(lock) {
            ensureSeq(ctx)
            val next = seq + 1L

            val obj = JSONObject()
            obj.put("seq", next)
            // UUID nasce aqui: e a chave de idempotencia do sync (uniao de
            // conjuntos por uuid) e vira o point id no Qdrant.
            obj.put("uuid", UUID.randomUUID().toString())
            obj.put("event_type", eventType)
            // track_id e SEMPRE string: id u64 do acervo estoura 2^53 em JS.
            obj.put("track_id", trackId)
            obj.put("origin", origin)
            obj.put("context_id", contextId ?: JSONObject.NULL)
            obj.put("started_at", startedAt)
            obj.put("timestamp", timestamp)
            obj.put("end_position_ms", endPositionMs)
            obj.put("duration_ms", durationMs)
            // So quando true: o payload sincado pro desktop ignora o campo, e
            // uma linha a mais por evento em TODO evento nao paga o custo.
            if (backward) obj.put("backward", true)

            try {
                FileOutputStream(file(ctx), true).use { out ->
                    out.write((obj.toString() + "\n").toByteArray(Charsets.UTF_8))
                    out.flush()
                    // fsync por evento: e ~1 escrita por faixa, e perder evento
                    // e perder dado de produto.
                    out.fd.sync()
                }
            } catch (e: Exception) {
                Log.e(TAG, "falha gravando evento no journal", e)
                return -1L
            }

            seq = next
            prefs(ctx).edit().putLong(KEY_SEQ, next).commit()
            return next
        }
    }

    /** Eventos com `seq` > [afterSeq], mais o maior `seq` ja gravado. */
    fun drain(ctx: Context, afterSeq: Long): DrainResult {
        synchronized(lock) {
            ensureSeq(ctx)
            val events = JSONArray()
            val f = file(ctx)
            if (f.exists()) {
                try {
                    f.forEachLine { line ->
                        val trimmed = line.trim()
                        if (trimmed.isNotEmpty()) {
                            try {
                                val obj = JSONObject(trimmed)
                                if (obj.optLong("seq", -1L) > afterSeq) {
                                    events.put(obj)
                                }
                            } catch (e: Exception) {
                                Log.w(TAG, "linha invalida no journal, ignorada")
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "falha lendo journal", e)
                }
            }
            return DrainResult(events, seq)
        }
    }

    /** Persiste a marca d'agua de consumo e compacta o arquivo ate ela. */
    fun ack(ctx: Context, uptoSeq: Long) {
        synchronized(lock) {
            ensureSeq(ctx)
            prefs(ctx).edit().putLong(KEY_ACK, uptoSeq).commit()
            compact(ctx, uptoSeq)
        }
    }

    fun ackedSeq(ctx: Context): Long = prefs(ctx).getLong(KEY_ACK, 0L)

    private fun compact(ctx: Context, uptoSeq: Long) {
        val f = file(ctx)
        if (!f.exists()) return
        val tmp = File(ctx.filesDir, TMP_NAME)
        try {
            var dropped = 0
            FileOutputStream(tmp, false).use { out ->
                f.forEachLine { line ->
                    val trimmed = line.trim()
                    if (trimmed.isNotEmpty()) {
                        if (seqOf(trimmed) > uptoSeq) {
                            out.write((trimmed + "\n").toByteArray(Charsets.UTF_8))
                        } else {
                            dropped++
                        }
                    }
                }
                out.flush()
                out.fd.sync()
            }
            if (dropped == 0) {
                tmp.delete()
                return
            }
            // rename(2) no mesmo diretorio: troca atomica, nunca deixa o
            // journal num estado meio-escrito.
            if (!tmp.renameTo(f)) {
                Log.e(TAG, "falha ao trocar o journal compactado; mantendo o original")
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.e(TAG, "falha compactando journal", e)
            tmp.delete()
        }
    }
}
