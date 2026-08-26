package app.tauri.rustifyaudio

import java.util.Random

/**
 * Copia de [items] com a cauda DEPOIS de [current] embaralhada (Fisher-Yates
 * com o [rng] injetado — determinístico sob seed, e por isso testável na JVM).
 *
 * `[0..current]` sai intacto: o que já tocou e o que toca não se movem. Cauda
 * com menos de 2 itens volta idêntica (não há o que permutar). `current = -1`
 * embaralha a lista inteira; índice além do fim é tratado como "sem cauda".
 *
 * Pura de propósito: o command `shuffleUpcoming` do [AudioPlugin] só a aplica
 * sobre os MediaItems do player e entrega o resultado ao `replaceMediaItems`.
 */
fun <T> shuffledTail(items: List<T>, current: Int, rng: Random): List<T> {
    val from = (current + 1).coerceIn(0, items.size)
    if (items.size - from < 2) return items.toList()
    val out = items.toMutableList()
    for (i in out.size - 1 downTo from + 1) {
        val j = from + rng.nextInt(i - from + 1)
        val tmp = out[i]
        out[i] = out[j]
        out[j] = tmp
    }
    return out
}
