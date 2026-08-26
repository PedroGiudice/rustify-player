package app.tauri.rustifyaudio

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.Logger
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

private const val ALIAS_POST_NOTIFICATIONS = "postNotifications"
private const val EVENT_FFT = "fft"

@InvokeArg
class QueueItemArg {
    lateinit var trackId: String
    lateinit var uri: String
    var title: String = ""
    var artist: String = ""
    var album: String = ""
    var artworkUri: String? = null
    var durationMs: Long = 0L
    /** Override por item; `null` herda a origem da fila. */
    var origin: String? = null
    var contextId: String? = null
}

@InvokeArg
class AddItemsArgs {
    var items: Array<QueueItemArg> = emptyArray()
    var origin: String = "manual"
    var contextId: String? = null
    /** `next` = logo depois da faixa corrente; `end` = fim da fila. */
    var mode: String = "end"
    /**
     * Retoma quando o player ja tinha chegado ao fim da fila. Sem isto,
     * anexar em STATE_ENDED nao volta a tocar: o ExoPlayer fica parado no
     * fim do ultimo item e o "autoplay" so funcionaria com o app aberto.
     */
    var resumeIfEnded: Boolean = false
}

@InvokeArg
class SetQueueArgs {
    // Array (nao List) pelo mesmo motivo dos plugins oficiais: o Jackson do
    // tauri-android resolve array sem depender do modulo Kotlin.
    var items: Array<QueueItemArg> = emptyArray()
    var startIndex: Int = 0
    var origin: String = "unknown"
    var contextId: String? = null
    var playNow: Boolean = true
}

@InvokeArg
class SeekToArgs {
    var positionMs: Long = 0L
}

@InvokeArg
class TruncateQueueArgs {
    /** Remove daqui ate o fim. Nunca corta a faixa corrente. */
    var fromIndex: Int = 0
}

@InvokeArg
class RepeatModeArgs {
    /** `off` | `one` | `all` */
    var mode: String = "off"
}

@InvokeArg
class SkipToIndexArgs {
    var index: Int = 0
}

@InvokeArg
class DrainEventsArgs {
    var afterSeq: Long = 0L
}

@InvokeArg
class AckEventsArgs {
    var uptoSeq: Long = 0L
}

@InvokeArg
class SetLikeArgs {
    lateinit var trackId: String
    var liked: Boolean = true
}

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

@UnstableApi
@TauriPlugin(
    permissions = [
        Permission(
            strings = [Manifest.permission.POST_NOTIFICATIONS],
            alias = ALIAS_POST_NOTIFICATIONS
        )
    ]
)
class AudioPlugin(private val activity: Activity) : Plugin(activity), PlaybackBus.Sink,
    SpectrumBus.Sink, UpdaterBus.Sink {

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null

    /**
     * Operacao esperando a conexao do MediaController. Guarda o [Invoke] junto
     * da closure: sem isso, toda operacao descartada (falha de conexao ou
     * Activity destruida) deixaria a promise do JS pendurada PARA SEMPRE — que
     * e exatamente a race do WebView frio que pendurou o boot em 14/08.
     */
    private class PendingOp(val invoke: Invoke?, val op: (MediaController) -> Unit)

    private val pending = ArrayDeque<PendingOp>()

    override fun load(webView: WebView) {
        PlaybackBus.sink = this
        SpectrumBus.sink = this
        UpdaterBus.sink = this
    }

    override fun onDestroy() {
        // so limpa se o sink ainda for este: numa recriacao de Activity o
        // plugin novo ja registrou o dele antes do onDestroy do antigo chegar
        if (PlaybackBus.sink === this) {
            PlaybackBus.sink = null
        }
        if (SpectrumBus.sink === this) {
            SpectrumBus.sink = null
        }
        if (UpdaterBus.sink === this) {
            UpdaterBus.sink = null
        }
        releaseController()
    }

    /**
     * Lido do lifecycle REAL da Activity, não de um flag em onResume/onPause:
     * o plugin é registrado depois do primeiro resume (a partir da thread
     * Rust), então um flag ficaria false no cold start e diferiria a
     * confirmação mesmo com o app na frente.
     */
    override fun isResumed(): Boolean =
        (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true

    /** Confirmação que chegou com o app invisível: dispara agora, visível. */
    override fun onResume() {
        val confirm = PendingConfirm.intent ?: return
        PendingConfirm.intent = null
        UpdateInstallReceiver.launchConfirm(activity, confirm)
    }

    // -------------------------------------------------------------- commands

    @Command
    fun initialize(invoke: Invoke) {
        ensureController()
        val needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState(ALIAS_POST_NOTIFICATIONS) != PermissionState.GRANTED
        if (needsPermission) {
            requestPermissionForAlias(ALIAS_POST_NOTIFICATIONS, invoke, "notificationPermissionCallback")
        } else {
            invoke.resolve()
        }
    }

    @PermissionCallback
    fun notificationPermissionCallback(invoke: Invoke) {
        // Playback nao depende da permissao — negada, some so a notificacao de
        // midia. Nao ha razao pra falhar o initialize por isso.
        invoke.resolve()
    }

    /** Meta por item, com fallback na origem da fila. */
    private fun metaMap(
        args: Array<QueueItemArg>,
        origin: String,
        contextId: String?,
    ): HashMap<String, QueueMeta.ItemMeta> {
        val map = HashMap<String, QueueMeta.ItemMeta>(args.size)
        for (item in args) {
            map[item.trackId] = QueueMeta.ItemMeta(
                item.origin ?: origin,
                if (item.origin != null) item.contextId else item.contextId ?: contextId,
                item.durationMs,
            )
        }
        return map
    }

    @Command
    fun setQueue(invoke: Invoke) {
        val args = invoke.parseArgs(SetQueueArgs::class.java)
        val items = args.items.map { buildMediaItem(it) }
        val origin = args.origin
        val contextId = args.contextId
        val metas = metaMap(args.items, origin, contextId)
        val playNow = args.playNow
        val startIndex = if (items.isEmpty()) 0 else args.startIndex.coerceIn(0, items.size - 1)

        withController(invoke) { c ->
            // O QueueMeta e escrito DENTRO do lambda pra manter a ordem com o
            // setMediaItems: o service le o meta ao adotar a faixa nova, e a
            // faixa velha ja foi congelada nos campos dele.
            QueueMeta.replaceAll(origin, contextId, metas)
            if (items.isEmpty()) {
                c.clearMediaItems()
            } else {
                c.setMediaItems(items, startIndex, 0L)
                c.prepare()
                if (playNow) c.play()
            }
            invoke.resolve()
        }
    }

    @Command
    fun play(invoke: Invoke) {
        withController(invoke) {
            it.play()
            invoke.resolve()
        }
    }

    @Command
    fun pause(invoke: Invoke) {
        withController(invoke) {
            it.pause()
            invoke.resolve()
        }
    }

    @Command
    fun seekTo(invoke: Invoke) {
        val args = invoke.parseArgs(SeekToArgs::class.java)
        val position = args.positionMs.coerceAtLeast(0L)
        withController(invoke) {
            it.seekTo(position)
            invoke.resolve()
        }
    }

    @Command
    fun next(invoke: Invoke) {
        withController(invoke) { c ->
            val moved = c.hasNextMediaItem()
            if (moved) c.seekToNextMediaItem()
            // `moved=false` diz ao JS que a fila acabou — sem isso o botao e um
            // no-op mudo (o desktop, no mesmo gesto, cai no autoplay).
            val payload = JSObject()
            payload.put("moved", moved)
            invoke.resolve(payload)
        }
    }

    @Command
    fun previous(invoke: Invoke) {
        // "previous" e sempre faixa anterior; sem o comportamento de reiniciar a
        // atual quando ja passou de N segundos (o journal veria isso como nada).
        withController(invoke) { c ->
            val moved = c.hasPreviousMediaItem()
            if (moved) c.seekToPreviousMediaItem() else c.seekTo(0L)
            val payload = JSObject()
            payload.put("moved", moved)
            invoke.resolve(payload)
        }
    }

    @Command
    fun skipToIndex(invoke: Invoke) {
        val args = invoke.parseArgs(SkipToIndexArgs::class.java)
        withController(invoke) { c ->
            val count = c.mediaItemCount
            if (count > 0) c.seekTo(args.index.coerceIn(0, count - 1), 0L)
            invoke.resolve()
        }
    }

    @Command
    fun getState(invoke: Invoke) {
        withController(invoke) { c ->
            invoke.resolve(snapshotToJs(snapshotOf(c)))
        }
    }

    /**
     * Snapshot da fila NATIVA. E a unica leitura da verdade: antes disto a UI
     * mantinha um espelho em localStorage que mentia sempre que o WebView
     * reiniciava com o servico tocando.
     */
    @Command
    fun getQueue(invoke: Invoke) {
        withController(invoke) { c ->
            invoke.resolve(queueSnapshotToJs(c))
        }
    }

    /**
     * Enfileira sem destruir a fila viva.
     *
     * O indice de insercao e resolvido AQUI, contra o `currentMediaItemIndex`
     * do proprio player, e nunca vem calculado do JS: a fila e nativa e avanca
     * sozinha, entao qualquer indice que o JS calcule ja pode estar velho
     * quando a chamada chega — e a faixa entraria no lugar errado.
     */
    @Command
    fun addItems(invoke: Invoke) {
        val args = invoke.parseArgs(AddItemsArgs::class.java)
        if (args.items.isEmpty()) {
            withController(invoke) { c -> invoke.resolve(queueSnapshotToJs(c)) }
            return
        }
        val items = args.items.map { buildMediaItem(it) }
        val metas = metaMap(args.items, args.origin, args.contextId)
        val next = args.mode == "next"

        withController(invoke) { c ->
            QueueMeta.putAll(metas)
            val count = c.mediaItemCount
            val wasEnded = c.playbackState == Player.STATE_ENDED
            if (count == 0) {
                c.setMediaItems(items, 0, 0L)
                c.prepare()
                if (args.resumeIfEnded) c.play()
            } else if (next) {
                c.addMediaItems((c.currentMediaItemIndex + 1).coerceIn(0, count), items)
            } else {
                c.addMediaItems(items)
            }
            // Fila que ja tinha acabado: o item novo entra depois do fim e o
            // player continua parado ali. Pular ate ele e o que faz a musica
            // voltar sozinha.
            if (args.resumeIfEnded && wasEnded && count > 0) {
                c.seekTo(count, 0L)
                c.prepare()
                c.play()
            }
            invoke.resolve(queueSnapshotToJs(c))
        }
    }

    /**
     * Descarta a cauda ainda nao tocada. E o que permite a station reagir a
     * um skip: joga fora o que ficou obsoleto e pede lote novo.
     *
     * A faixa CORRENTE nunca e removida — cortar o item que esta tocando
     * pararia o som, que e o oposto da intencao.
     */
    @Command
    fun truncateQueue(invoke: Invoke) {
        val args = invoke.parseArgs(TruncateQueueArgs::class.java)
        withController(invoke) { c ->
            val count = c.mediaItemCount
            val floor = (c.currentMediaItemIndex + 1).coerceAtLeast(0)
            val from = args.fromIndex.coerceAtLeast(floor)
            if (from < count) c.removeMediaItems(from, count)
            invoke.resolve(queueSnapshotToJs(c))
        }
    }

    /**
     * Re-embaralha SO o que ainda vai tocar (CMR-218). Acao one-shot e
     * repetivel: nao ha estado de "shuffle ligado" nem restauracao da ordem.
     *
     * Nunca toca a faixa corrente nem o ja tocado — a cauda e trocada de uma
     * vez por `replaceMediaItems`, atomico frente ao tender e ao auto-advance
     * (truncar + re-adicionar pelo JS seriam dois IPCs com janela entre eles).
     * O [QueueMeta] e chaveado por trackId: reordenar nao mexe na origem nem
     * no contextId de item nenhum.
     *
     * Limitacao conhecida: o tender (Rust) decide o corte de `truncate_queue`
     * a partir de um `get_queue` anterior — dois IPCs. Um shuffle que cai
     * ENTRE os dois reordena a cauda e o corte posicional pode deslocar (uma
     * faixa a mais ou a menos descartada). Janela de milissegundos, sem risco
     * pra faixa corrente (o truncate nunca a corta); aceita.
     */
    @Command
    fun shuffleUpcoming(invoke: Invoke) {
        withController(invoke) { c ->
            val count = c.mediaItemCount
            // currentMediaItemIndex nunca e negativo (fila vazia = 0), entao
            // `from` >= 1 sem coerce; fila vazia cai no guard abaixo.
            val current = c.currentMediaItemIndex
            val from = current + 1
            if (count - from >= 2) {
                val all = (0 until count).map { c.getMediaItemAt(it) }
                val tail = shuffledTail(all, current, java.util.Random()).subList(from, count)
                c.replaceMediaItems(from, count, tail)
            }
            invoke.resolve(queueSnapshotToJs(c))
        }
    }

    @Command
    fun setRepeatMode(invoke: Invoke) {
        val args = invoke.parseArgs(RepeatModeArgs::class.java)
        val mode = when (args.mode) {
            "one" -> Player.REPEAT_MODE_ONE
            "all" -> Player.REPEAT_MODE_ALL
            else -> Player.REPEAT_MODE_OFF
        }
        withController(invoke) { c ->
            c.repeatMode = mode
            invoke.resolve()
        }
    }

    @Command
    fun drainEvents(invoke: Invoke) {
        val args = invoke.parseArgs(DrainEventsArgs::class.java)
        val result = EventJournal.drain(activity, args.afterSeq)
        val payload = JSObject()
        payload.put("events", result.events)
        payload.put("lastSeq", result.lastSeq)
        invoke.resolve(payload)
    }

    @Command
    fun ackEvents(invoke: Invoke) {
        val args = invoke.parseArgs(AckEventsArgs::class.java)
        EventJournal.ack(activity, args.uptoSeq)
        invoke.resolve()
    }

    /**
     * Like/unlike de uma faixa (CMR-220): grava no journal, com a MESMA forma
     * da linha de play_event, e o sync leva ao desktop (que faz o LWW em
     * track_enrichments). SEM [withController] de proposito: nao se sobe o
     * service so para registrar um like — o controller e lido se ja estiver
     * conectado, apenas para posicao/duracao quando a faixa e a corrente.
     *
     * origin/contextId vem SO do proprio item no [QueueMeta]; faixa fora da
     * fila vai como `manual` sem contexto — herdar o escalar da fila carimbaria
     * o like com a rodada de outra sessao.
     */
    @Command
    fun setLike(invoke: Invoke) {
        val args = invoke.parseArgs(SetLikeArgs::class.java)
        val trackId = args.trackId
        val c = controller
        val isCurrent = c != null && c.currentMediaItem?.mediaId == trackId
        val pos = if (isCurrent) c!!.currentPosition.coerceAtLeast(0L) else 0L
        val dur = if (isCurrent && c!!.duration != C.TIME_UNSET) {
            c.duration.coerceAtLeast(0L)
        } else {
            QueueMeta.durationFor(trackId)
        }
        val meta = QueueMeta.itemMeta(trackId)
        val now = System.currentTimeMillis() / 1000L
        val seq = EventJournal.append(
            activity,
            if (args.liked) "like" else "unlike",
            trackId,
            meta?.origin ?: "manual",
            meta?.contextId,
            now,
            now,
            pos,
            dur
        )
        if (seq < 0L) {
            invoke.reject("falha gravando o like no journal")
            return
        }
        val payload = JSObject()
        payload.put("seq", seq)
        invoke.resolve(payload)
    }

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

    // ---------------------------------------------------------------- eventos

    override fun onPlaybackEvent(event: String, snapshot: PlaybackSnapshot) {
        if (!hasListener(event)) return
        trigger(event, snapshotToJs(snapshot))
    }

    /** Bandas do SpectrumTap (~25Hz, thread própria) → evento `fft`. */
    override fun onFft(low: Float, mid: Float, high: Float) {
        if (!hasListener(EVENT_FFT)) return
        val payload = JSObject()
        payload.put("low", low)
        payload.put("mid", mid)
        payload.put("high", high)
        trigger(EVENT_FFT, payload)
    }

    /** Progresso do updater (thread do download / receiver) -> evento. */
    override fun onUpdaterEvent(payload: JSObject) {
        if (!hasListener(EVENT_UPDATER_PROGRESS)) return
        trigger(EVENT_UPDATER_PROGRESS, payload)
    }

    // --------------------------------------------------------------- interno

    /**
     * Conecta ao [AudioService] via MediaController — caminho documentado do
     * Media3, que cuida de subir/derrubar o foreground service. A conexao e
     * assincrona, entao comandos que chegam antes dela ficam na fila [pending].
     */
    private fun ensureController() {
        if (controllerFuture != null) return
        val token = SessionToken(activity, ComponentName(activity, AudioService::class.java))
        val future = MediaController.Builder(activity, token).buildAsync()
        controllerFuture = future
        future.addListener(
            {
                try {
                    val connected = future.get()
                    controller = connected
                    while (pending.isNotEmpty()) {
                        run(pending.removeFirst(), connected)
                    }
                } catch (e: Exception) {
                    Logger.error("rustify-audio: falha conectando ao AudioService", e)
                    controllerFuture = null
                    failPending("conexao com o AudioService falhou")
                }
            },
            ContextCompat.getMainExecutor(activity)
        )
    }

    /**
     * Executa a operacao. Excecao dentro do lambda tambem rejeita o invoke: um
     * command que estoura no Media3 nao pode virar promise pendurada no JS.
     */
    private fun run(pendingOp: PendingOp, c: MediaController) {
        try {
            pendingOp.op(c)
        } catch (e: Exception) {
            Logger.error("rustify-audio: operacao falhou", e)
            pendingOp.invoke?.reject(e.message ?: "operacao de playback falhou")
        }
    }

    private fun failPending(reason: String) {
        while (pending.isNotEmpty()) {
            pending.removeFirst().invoke?.reject(reason)
        }
    }

    /**
     * Roda [op] com o controller conectado. Passar o [invoke] e obrigatorio para
     * todo command que responde ao JS — e a closure que resolve, dentro do
     * lambda, para que a resposta reflita o que de fato aconteceu (antes desta
     * mudanca os commands resolviam ANTES de tocar o player e mentiam em caso
     * de falha).
     */
    private fun withController(invoke: Invoke?, op: (MediaController) -> Unit) {
        val pendingOp = PendingOp(invoke, op)
        val connected = controller
        if (connected != null) {
            run(pendingOp, connected)
            return
        }
        pending.addLast(pendingOp)
        ensureController()
    }

    private fun releaseController() {
        controller?.release()
        controller = null
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        // Activity destruida com operacoes na fila (caso comum: app tirado dos
        // recentes com o servico tocando).
        failPending("controller liberado")
    }

    private fun buildMediaItem(item: QueueItemArg): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(item.title)
            .setArtist(item.artist)
            .setAlbumTitle(item.album)
            .setIsBrowsable(false)
            .setIsPlayable(true)
        if (item.durationMs > 0L) {
            metadata.setDurationMs(item.durationMs)
        }
        item.artworkUri?.takeIf { it.isNotEmpty() }?.let {
            metadata.setArtworkUri(Uri.parse(it))
        }
        return MediaItem.Builder()
            // mediaId carrega o track_id atraves do IPC do Media3; e o unico
            // elo entre o item tocando e o journal.
            .setMediaId(item.trackId)
            .setUri(item.uri)
            .setMediaMetadata(metadata.build())
            .build()
    }

    /**
     * Fila do player -> wire do contrato. `trackId` sai como String SEMPRE (os
     * ids do acervo sao u64 hash-based e passam de 2^53). A origem vem do
     * [QueueMeta] por ITEM: hoje ainda e o escalar da fila, mas o wire ja nasce
     * per-item para nao mudar quando o enfileirar por item chegar.
     */
    private fun queueSnapshotToJs(c: MediaController): JSObject {
        val items = JSArray()
        val count = c.mediaItemCount
        for (i in 0 until count) {
            val item = c.getMediaItemAt(i)
            val trackId = item.mediaId
            val meta = QueueMeta.metaFor(trackId)
            val entry = JSObject()
            entry.put("trackId", trackId)
            entry.put("origin", meta.origin)
            entry.put("contextId", meta.contextId ?: JSONObject.NULL)
            entry.put("durationMs", meta.durationMs)
            items.put(entry)
        }
        val obj = JSObject()
        obj.put("items", items)
        obj.put("index", if (count == 0) -1 else c.currentMediaItemIndex)
        return obj
    }

    private fun snapshotToJs(snapshot: PlaybackSnapshot): JSObject {
        val obj = JSObject()
        obj.put("status", snapshot.status)
        obj.put("index", snapshot.index)
        // JSONObject.NULL em vez de null: `put(key, null)` REMOVE a chave e o
        // lado Rust perderia o campo.
        obj.put("trackId", snapshot.trackId ?: JSONObject.NULL)
        obj.put("positionMs", snapshot.positionMs)
        obj.put("durationMs", snapshot.durationMs)
        obj.put("isPlaying", snapshot.isPlaying)
        obj.put("count", snapshot.count)
        obj.put("repeatMode", snapshot.repeatMode)
        return obj
    }
}
