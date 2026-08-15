package app.tauri.rustifyaudio

import java.util.concurrent.ConcurrentHashMap

/**
 * Metadados da fila corrente (`origin`, `context_id`, duracao) que o MediaItem
 * nao carrega. Plugin escreve, service le ao adotar a faixa corrente.
 *
 * **Por ITEM, nao por fila.** Enquanto `setQueue` era o unico caminho de
 * montagem a fila era homogenea e um escalar bastava. Com o enfileirar avulso
 * a fila fica MISTA — uma faixa posta a mao dentro de uma station e escolha
 * explicita do usuario (peso cheio no sinal v3), nao escuta passiva. Guardar a
 * origem por fila faria o journal mentir para o motor, silenciosamente.
 *
 * Vive em memoria de processo de proposito: plugin e service rodam no MESMO
 * processo e a fila nao sobrevive a morte dele. O service congela esses valores
 * em campos proprios ao adotar a faixa — o journal nunca le daqui na hora de
 * gravar, senao um `setQueue` novo carimbaria a faixa velha com origem errada.
 *
 * `trackId` repetido na mesma fila e last-write-wins (aceito: a mesma faixa
 * duas vezes na fila com origens diferentes e caso de borda sem consequencia
 * pratica no sinal).
 */
object QueueMeta {
    data class ItemMeta(val origin: String, val contextId: String?, val durationMs: Long)

    private val items = ConcurrentHashMap<String, ItemMeta>()

    /** Origem da fila corrente — fallback de item sem meta proprio. */
    @Volatile
    var origin: String = "unknown"
        private set

    @Volatile
    var contextId: String? = null
        private set

    /** Substitui o mapa inteiro (setQueue). */
    fun replaceAll(origin: String, contextId: String?, entries: Map<String, ItemMeta>) {
        this.origin = origin
        this.contextId = contextId
        items.clear()
        items.putAll(entries)
    }

    /** Acrescenta itens sem tocar no resto (addItems). */
    fun putAll(entries: Map<String, ItemMeta>) {
        items.putAll(entries)
    }

    fun durationFor(trackId: String): Long = items[trackId]?.durationMs ?: 0L

    /** Meta do item; sem registro proprio, herda o da fila. */
    fun metaFor(trackId: String): ItemMeta =
        items[trackId] ?: ItemMeta(origin, contextId, 0L)
}
