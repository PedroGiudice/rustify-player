package app.tauri.rustifyaudio

import android.app.PendingIntent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Dono do playback: ExoPlayer + MediaSession num foreground service de midia.
 *
 * A fila e NATIVA (lista de MediaItem do proprio ExoPlayer), entao o
 * auto-advance no fim da faixa nao depende do JS. Cada transicao vira uma linha
 * no [EventJournal] — inclusive com a tela apagada e o WebView suspenso.
 */
@UnstableApi
class AudioService : MediaSessionService() {

    private var player: ExoPlayer? = null
    private var session: MediaSession? = null
    private val handler = Handler(Looper.getMainLooper())
    private var ticking = false

    // Faixa corrente CONGELADA no instante em que virou corrente. O journal usa
    // estes campos, nunca o QueueMeta vivo: um setQueue novo ja trocou o meta
    // antes do flush da faixa que estava tocando.
    private var curTrackId: String? = null
    private var curOrigin: String = "unknown"
    private var curContextId: String? = null
    private var curDurationMs: Long = 0L
    private var curStartedAt: Long = 0L
    private var lastPositionMs: Long = 0L

    // Capturados por callbacks do MESMO lote de eventos e consumidos em
    // onEvents, que o Media3 garante rodar depois de todos eles. Assim o flush
    // nao depende da ordem entre onPositionDiscontinuity e onMediaItemTransition.
    private var pendingTransition = false
    private var pendingReason = -1
    private var pendingOldPositionMs: Long? = null
    // Direcao do pulo. Voltar pra faixa anterior (fone, notificacao, gesto) NAO
    // e rejeicao: sem esta marca a reacao de sessao trataria replay como
    // "nao gostei" e empurraria o radio pra longe do que o usuario repetiu.
    private var pendingBackward = false

    override fun onCreate() {
        super.onCreate()

        val attributes = AudioAttributes.Builder()
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .setUsage(C.USAGE_MEDIA)
            .build()

        // Sink com o tap de spectrum (CMR-192): passthrough + bandas de FFT
        // pro bg do WebView. Ver SpectrumTap.kt.
        val renderersFactory = object : androidx.media3.exoplayer.DefaultRenderersFactory(this) {
            override fun buildAudioSink(
                context: android.content.Context,
                enableFloatOutput: Boolean,
                enableAudioTrackPlaybackParams: Boolean
            ): androidx.media3.exoplayer.audio.AudioSink {
                return androidx.media3.exoplayer.audio.DefaultAudioSink.Builder(context)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                    .setAudioProcessors(arrayOf(SpectrumTap()))
                    .build()
            }
        }

        val exo = ExoPlayer.Builder(this, renderersFactory)
            // handleAudioFocus=true: pausa em ligacao/outro app, retoma depois
            .setAudioAttributes(attributes, true)
            // desplugar o fone pausa em vez de vazar som no alto-falante
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        exo.addListener(playerListener)
        player = exo

        val sessionActivity = packageManager
            .getLaunchIntentForPackage(packageName)
            ?.let { intent ->
                PendingIntent.getActivity(
                    this,
                    0,
                    intent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            }

        val builder = MediaSession.Builder(this, exo).setId(SESSION_ID)
        if (sessionActivity != null) {
            builder.setSessionActivity(sessionActivity)
        }
        session = builder.build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        ticking = false

        // Ultima chance de nao perder a faixa que estava no ar.
        val exo = player
        if (exo != null && curTrackId != null) {
            val position = exo.currentPosition.coerceAtLeast(0L)
            flushCurrent("track_skipped", if (position > 0L) position else lastPositionMs)
            curTrackId = null
        }

        session?.let { active ->
            active.player.release()
            active.release()
        }
        session = null
        player = null
        super.onDestroy()
    }

    // ---------------------------------------------------------------- player

    private val playerListener = object : Player.Listener {
        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int
        ) {
            if (oldPosition.mediaItemIndex != newPosition.mediaItemIndex) {
                // posicao final da faixa que esta saindo; onEvents consome
                pendingOldPositionMs = oldPosition.positionMs.coerceAtLeast(0L)
                pendingBackward = newPosition.mediaItemIndex < oldPosition.mediaItemIndex
            } else {
                lastPositionMs = newPosition.positionMs.coerceAtLeast(0L)
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            pendingTransition = true
            pendingReason = reason
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.e(TAG, "erro de playback", error)
        }

        override fun onEvents(activePlayer: Player, events: Player.Events) {
            if (pendingTransition) {
                handleTransition(activePlayer)
            }

            if (events.contains(Player.EVENT_IS_PLAYING_CHANGED)) {
                if (activePlayer.isPlaying) {
                    // replay depois de STATE_ENDED nao gera transicao: readota
                    if (curTrackId == null) adoptCurrent(activePlayer)
                    if (curStartedAt == 0L) curStartedAt = nowSeconds()
                } else {
                    lastPositionMs = activePlayer.currentPosition.coerceAtLeast(0L)
                }
                syncTicker(activePlayer)
                PlaybackBus.emit(EVENT_STATE_CHANGED, snapshotOf(activePlayer))
            }

            if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED)) {
                if (activePlayer.playbackState == Player.STATE_ENDED && curTrackId != null) {
                    // fim da fila: nao ha transicao pra disparar o flush
                    val end = if (curDurationMs > 0L) curDurationMs else lastPositionMs
                    flushCurrent("track_ended", end)
                    curTrackId = null
                }
                PlaybackBus.emit(EVENT_STATE_CHANGED, snapshotOf(activePlayer))
            }

            // mantem a duracao da faixa corrente fresca (o valor vindo do JS e
            // so um palpite ate o extractor abrir o arquivo)
            val duration = activePlayer.duration
            if (duration != C.TIME_UNSET && duration > 0L &&
                activePlayer.currentMediaItem?.mediaId == curTrackId
            ) {
                curDurationMs = duration
            }
        }
    }

    private fun handleTransition(activePlayer: Player) {
        val reason = pendingReason
        val captured = pendingOldPositionMs
        val backward = pendingBackward
        pendingTransition = false
        pendingReason = -1
        pendingOldPositionMs = null
        pendingBackward = false

        if (curTrackId != null) {
            val natural = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO ||
                reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT
            val end = captured ?: lastPositionMs
            val endPosition = if (natural && end <= 0L) curDurationMs else end
            flushCurrent(
                if (natural) "track_ended" else "track_skipped",
                endPosition,
                backward = !natural && backward
            )
        }

        adoptCurrent(activePlayer)
        PlaybackBus.emit(EVENT_TRACK_CHANGED, snapshotOf(activePlayer))
    }

    private fun adoptCurrent(activePlayer: Player) {
        val trackId = activePlayer.currentMediaItem?.mediaId?.takeIf { it.isNotEmpty() }
        curTrackId = trackId
        // Origem POR ITEM: a faixa enfileirada a mao dentro de uma station e
        // escolha explicita (peso cheio no v3), nao escuta passiva.
        val meta = if (trackId != null) QueueMeta.metaFor(trackId) else null
        // Repeat-one: a re-escuta e deliberada, e o sinal v3 trata `repeat`
        // como positivo pleno (mesma semantica do desktop). Sem isto o
        // celular nunca emitiria esse origin.
        curOrigin = if (activePlayer.repeatMode == Player.REPEAT_MODE_ONE) {
            "repeat"
        } else {
            meta?.origin ?: QueueMeta.origin
        }
        curContextId = meta?.contextId ?: QueueMeta.contextId
        curDurationMs = meta?.durationMs ?: 0L
        val duration = activePlayer.duration
        if (duration != C.TIME_UNSET && duration > 0L) {
            curDurationMs = duration
        }
        // started_at so conta quando a faixa realmente comeca a tocar
        curStartedAt = if (activePlayer.isPlaying) nowSeconds() else 0L
        lastPositionMs = activePlayer.currentPosition.coerceAtLeast(0L)
    }

    private fun flushCurrent(eventType: String, endPositionMs: Long, backward: Boolean = false) {
        val trackId = curTrackId ?: return
        val now = nowSeconds()
        EventJournal.append(
            applicationContext,
            eventType,
            trackId,
            curOrigin,
            curContextId,
            if (curStartedAt > 0L) curStartedAt else now,
            now,
            endPositionMs.coerceAtLeast(0L),
            curDurationMs.coerceAtLeast(0L),
            backward
        )
    }

    // ---------------------------------------------------------------- ticker

    private val tick = object : Runnable {
        override fun run() {
            val exo = player
            if (exo == null) {
                ticking = false
                return
            }
            lastPositionMs = exo.currentPosition.coerceAtLeast(0L)
            val duration = exo.duration
            if (duration != C.TIME_UNSET && duration > 0L) {
                curDurationMs = duration
            }
            PlaybackBus.emit(EVENT_POSITION, snapshotOf(exo))
            if (exo.isPlaying) {
                handler.postDelayed(this, TICK_INTERVAL_MS)
            } else {
                ticking = false
            }
        }
    }

    private fun syncTicker(activePlayer: Player) {
        if (activePlayer.isPlaying && !ticking) {
            ticking = true
            handler.postDelayed(tick, TICK_INTERVAL_MS)
        } else if (!activePlayer.isPlaying && ticking) {
            ticking = false
            handler.removeCallbacks(tick)
        }
    }

    private fun nowSeconds(): Long = System.currentTimeMillis() / 1000L

    companion object {
        private const val TAG = "RustifyAudioService"
        private const val SESSION_ID = "rustify-audio"
        private const val TICK_INTERVAL_MS = 500L

        const val EVENT_STATE_CHANGED = "state_changed"
        const val EVENT_TRACK_CHANGED = "track_changed"
        const val EVENT_POSITION = "position"
    }
}
