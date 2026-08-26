package app.tauri.rustifyaudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterTest {
    @Test
    fun semver_compara_por_componente_numerico() {
        assertTrue(Semver.compare("0.2.76", "0.2.75") > 0)
        assertTrue(Semver.compare("0.2.75", "0.2.76") < 0)
        assertEquals(0, Semver.compare("0.2.75", "0.2.75"))
        // 0.10 > 0.9 (numérico, não lexicográfico)
        assertTrue(Semver.compare("0.10.0", "0.9.9") > 0)
        // prefixo v e sufixo não numérico são tolerados
        assertTrue(Semver.compare("v1.0.0", "0.9.0") > 0)
        assertEquals(0, Semver.compare("1.2.3-debug", "1.2.3"))
    }

    @Test
    fun manifest_parse_le_os_quatro_campos() {
        val m = UpdateManifest.parse(
            """{"version":"0.2.76","apk_url":"https://h/x.apk","sha256":"AB","size":42}"""
        )
        assertEquals("0.2.76", m.version)
        assertEquals("https://h/x.apk", m.apkUrl)
        assertEquals("AB", m.sha256)
        assertEquals(42L, m.size)
    }

    @Test
    fun manifest_parse_tolera_sha_e_size_ausentes() {
        val m = UpdateManifest.parse("""{"version":"0.2.76","apk_url":"https://h/x.apk"}""")
        assertNull(m.sha256)
        assertEquals(0L, m.size)
    }

    @Test(expected = IllegalArgumentException::class)
    fun manifest_parse_rejeita_sem_version() {
        UpdateManifest.parse("""{"apk_url":"https://h/x.apk"}""")
    }
}
