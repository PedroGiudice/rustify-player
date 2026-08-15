package app.tauri.rustifyaudio

import java.util.concurrent.ConcurrentHashMap

/**
 * Metadados da fila corrente (`origin`, `context_id`, duracao por faixa) que o
 * MediaItem nao carrega. Plugin escreve, service le ao adotar a faixa corrente.
 *
 * Vive em memoria de processo de proposito: plugin e service rodam no MESMO
 * processo e a fila nao sobrevive a morte dele. O service congela esses valores
 * em campos proprios ao adotar a faixa — o journal nunca le daqui na hora de
 * gravar, senao um `setQueue` novo carimbaria a faixa velha com origem errada.
 */
object QueueMeta {
    @Volatile
    var origin: String = "unknown"
        private set

    @Volatile
    var contextId: String? = null
        private set

    private val durations = ConcurrentHashMap<String, Long>()

    fun set(origin: String, contextId: String?, durations: Map<String, Long>) {
        this.origin = origin
        this.contextId = contextId
        this.durations.clear()
        for ((key, value) in durations) {
            this.durations[key] = value
        }
    }

    fun durationFor(trackId: String): Long = durations[trackId] ?: 0L

    /** Metadados de UM item da fila. */
    data class ItemMeta(val origin: String, val contextId: String?, val durationMs: Long)

    /**
     * Meta da faixa para o snapshot da fila. Hoje devolve o escalar da fila
     * corrente para todos os itens — a fila e homogenea porque `setQueue` e o
     * unico caminho de montagem. Quando o enfileirar por item chegar, so esta
     * funcao muda: o wire de `get_queue` ja e per-item.
     */
    fun metaFor(trackId: String): ItemMeta = ItemMeta(origin, contextId, durationFor(trackId))
}
