package app.tauri.rustifyaudio

import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi

/** Estado do player numa forma serializavel, sem depender de nada do Tauri. */
data class PlaybackSnapshot(
    val status: String,
    val index: Int,
    val trackId: String?,
    val positionMs: Long,
    val durationMs: Long,
    val isPlaying: Boolean,
    /** Itens na fila nativa. E o que permite decidir "esta acabando" sem
     *  precisar ler a fila inteira a cada ciclo do tender de continuidade. */
    val count: Int = 0,
    /** off | one | all — com repeat ligado a fila nunca "seca": o tender NAO
     *  pode injetar autoplay por cima de um loop deliberado do usuario. */
    val repeatMode: String = "off"
)

/**
 * Canal best-effort service -> plugin -> webview. Perder evento daqui nao perde
 * dado: a verdade do que foi escutado esta no [EventJournal].
 */
object PlaybackBus {
    interface Sink {
        fun onPlaybackEvent(event: String, snapshot: PlaybackSnapshot)
    }

    @Volatile
    var sink: Sink? = null

    val hasSink: Boolean
        get() = sink != null

    fun emit(event: String, snapshot: PlaybackSnapshot) {
        sink?.onPlaybackEvent(event, snapshot)
    }
}

/** Serve tanto pro ExoPlayer (service) quanto pro MediaController (plugin). */
@UnstableApi
fun snapshotOf(player: Player?): PlaybackSnapshot {
    if (player == null) {
        return PlaybackSnapshot("idle", -1, null, 0L, 0L, false, 0, "off")
    }
    val duration = player.duration
    val status = when (player.playbackState) {
        Player.STATE_BUFFERING -> "buffering"
        Player.STATE_READY -> "ready"
        Player.STATE_ENDED -> "ended"
        else -> "idle"
    }
    return PlaybackSnapshot(
        status = status,
        index = if (player.mediaItemCount == 0) -1 else player.currentMediaItemIndex,
        trackId = player.currentMediaItem?.mediaId?.takeIf { it.isNotEmpty() },
        positionMs = player.currentPosition.coerceAtLeast(0L),
        durationMs = if (duration == C.TIME_UNSET) 0L else duration.coerceAtLeast(0L),
        isPlaying = player.isPlaying,
        count = player.mediaItemCount,
        repeatMode = when (player.repeatMode) {
            Player.REPEAT_MODE_ONE -> "one"
            Player.REPEAT_MODE_ALL -> "all"
            else -> "off"
        }
    )
}
