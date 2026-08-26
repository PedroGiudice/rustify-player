package app.tauri.rustifyaudio

import java.util.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QueueOpsTest {
    private val fila = listOf("a", "b", "c", "d", "e", "f", "g", "h")

    @Test
    fun preserva_cabeca_e_corrente_e_permuta_a_cauda() {
        var algumaDiferente = false
        for (seed in 0L until 40L) {
            val out = shuffledTail(fila, 2, Random(seed))
            assertEquals(fila.size, out.size)
            // [0..current] intacto — o que já tocou e o que toca não se movem
            assertEquals(listOf("a", "b", "c"), out.subList(0, 3))
            // a cauda é o mesmo multiset, só a ordem muda
            assertEquals(fila.subList(3, fila.size).sorted(), out.subList(3, out.size).sorted())
            if (out.subList(3, out.size) != fila.subList(3, fila.size)) algumaDiferente = true
        }
        assertTrue("nenhum seed mudou a ordem da cauda", algumaDiferente)
    }

    @Test
    fun cauda_com_menos_de_dois_itens_volta_identica() {
        // corrente no penúltimo: só 1 a seguir
        assertEquals(fila, shuffledTail(fila, fila.size - 2, Random(7)))
        // corrente no último: nada a seguir
        assertEquals(fila, shuffledTail(fila, fila.size - 1, Random(7)))
        // corrente além do fim (índice velho) não estoura
        assertEquals(fila, shuffledTail(fila, fila.size + 3, Random(7)))
    }

    @Test
    fun lista_vazia_volta_vazia() {
        assertEquals(emptyList<String>(), shuffledTail(emptyList<String>(), -1, Random(1)))
        assertEquals(emptyList<String>(), shuffledTail(emptyList<String>(), 0, Random(1)))
    }

    @Test
    fun corrente_menos_um_embaralha_tudo() {
        var algumaDiferente = false
        for (seed in 0L until 40L) {
            val out = shuffledTail(fila, -1, Random(seed))
            assertEquals(fila.sorted(), out.sorted())
            if (out != fila) algumaDiferente = true
        }
        assertTrue("nenhum seed mudou a ordem", algumaDiferente)
    }

    @Test
    fun nao_muta_a_lista_de_entrada() {
        val original = fila.toList()
        shuffledTail(fila, 1, Random(3))
        assertEquals(original, fila)
    }
}
