package app.tauri.rustifyaudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A linha de like/unlike (CMR-220) PRECISA ter a mesma forma da linha de
 * play_event: os parsers (PlayEvent no Rust do plugin, JournalEvent no
 * mobile_sync) exigem todos os campos e uma linha inválida no lote trava o
 * sync inteiro sem ack.
 */
class EventJournalLineTest {
    private val chavesDoPlayEvent = setOf(
        "seq", "uuid", "event_type", "track_id", "origin", "context_id",
        "started_at", "timestamp", "end_position_ms", "duration_ms",
    )

    @Test
    fun like_line_tem_o_mesmo_shape_do_play_event() {
        val line = EventJournal.lineOf(
            seq = 7L,
            uuid = "u-1",
            eventType = "like",
            trackId = "18446744073709551615",
            origin = "manual",
            contextId = "ctx",
            startedAt = 100L,
            timestamp = 100L,
            endPositionMs = 42_000L,
            durationMs = 200_000L,
            backward = false,
        )
        val keys = mutableSetOf<String>()
        for (k in line.keys()) keys.add(k)
        assertEquals(chavesDoPlayEvent, keys)
        assertFalse("backward só aparece quando true", line.has("backward"))
        // track_id é SEMPRE string: id u64 do acervo estoura 2^53 em JS.
        assertTrue(line.get("track_id") is String)
        assertEquals("18446744073709551615", line.getString("track_id"))
        assertEquals("like", line.getString("event_type"))
        assertEquals(7L, line.getLong("seq"))
        assertEquals(42_000L, line.getLong("end_position_ms"))
    }

    @Test
    fun unlike_line_com_context_null_serializa_JSONObject_NULL() {
        val line = EventJournal.lineOf(
            seq = 8L,
            uuid = "u-2",
            eventType = "unlike",
            trackId = "7",
            origin = "manual",
            contextId = null,
            startedAt = 5L,
            timestamp = 5L,
            endPositionMs = 0L,
            durationMs = 0L,
            backward = false,
        )
        // `put(key, null)` REMOVERIA a chave; o parser do Rust exige o campo.
        assertTrue(line.has("context_id"))
        assertTrue(line.isNull("context_id"))
        assertEquals(JSONObject.NULL, line.get("context_id"))
        assertEquals("unlike", line.getString("event_type"))
        // A serialização mantém o null explícito na linha do journal.
        assertTrue(line.toString().contains("\"context_id\":null"))
    }
}
