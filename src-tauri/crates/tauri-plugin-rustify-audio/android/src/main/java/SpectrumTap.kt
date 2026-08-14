package app.tauri.rustifyaudio

import android.os.Handler
import android.os.HandlerThread
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sqrt

/**
 * Canal best-effort das bandas de FFT (service -> plugin -> webview), gemeo do
 * [PlaybackBus]. Perder frame daqui e invisivel: o proximo chega em ~40ms.
 */
object SpectrumBus {
    interface Sink {
        fun onFft(low: Float, mid: Float, high: Float)
    }

    @Volatile
    var sink: Sink? = null

    fun emit(low: Float, mid: Float, high: Float) {
        sink?.onFft(low, mid, high)
    }
}

/**
 * Tap de PCM no sink do ExoPlayer (CMR-192): passa o audio adiante intacto e
 * copia as amostras pra derivar as 3 bandas do beat-sync do background.
 *
 * A matematica e a MESMA do desktop (audio-engine pw_capture.rs — fonte da
 * verdade das constantes): FFT 2048 com janela Hanning, magnitude linear
 * normalizada por 1/N, media por banda 20-200 / 200-2k / 2k-12k Hz,
 * soft-compress sqrt*4, envelope follower attack 5ms / release 100ms. Assim o
 * PLL do frontend (beatPll.ts, KICK_FLOOR/CEIL) enxerga a mesma faixa dinamica
 * nos dois apps.
 *
 * Caminho escolhido em vez do android.media.audiofx.Visualizer: o Visualizer
 * exige RECORD_AUDIO (prompt de microfone num player de musica). O tap roda no
 * pipeline do proprio player, sem permissao nenhuma.
 *
 * Custo: copia das amostras na thread de audio (µs) + FFT 2048 a ~25Hz numa
 * HandlerThread propria. Pausado, nao chegam amostras novas e o worker emite
 * nada — o frontend congela via FFT_STALE_MS, igual ao desktop.
 */
@UnstableApi
class SpectrumTap : BaseAudioProcessor() {

    private val ring = FloatArray(RING_SIZE)
    private var ringPos = 0
    private var ringFilled = 0

    @Volatile
    private var lastSampleAtMs = 0L
    private var sampleRate = 48_000
    private var channels = 2

    private var worker: HandlerThread? = null
    private var handler: Handler? = null

    override fun onConfigure(
        inputAudioFormat: AudioProcessor.AudioFormat
    ): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            // Formato que nao sabemos ler: processor inativo, audio passa direto.
            return AudioProcessor.AudioFormat.NOT_SET
        }
        sampleRate = inputAudioFormat.sampleRate
        channels = inputAudioFormat.channelCount
        ensureWorker()
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val remaining = inputBuffer.remaining()
        if (remaining == 0) return

        // Copia pra analise ANTES de consumir o buffer no passthrough.
        val analysis = inputBuffer.asReadOnlyBuffer().order(inputBuffer.order())
        val frames = remaining / (2 * channels)
        synchronized(ring) {
            for (f in 0 until frames) {
                var acc = 0
                for (c in 0 until channels) {
                    acc += analysis.short.toInt()
                }
                ring[ringPos] = acc / (channels * 32768.0f)
                ringPos = (ringPos + 1) % RING_SIZE
            }
            ringFilled = minOf(ringFilled + frames, RING_SIZE)
        }
        lastSampleAtMs = System.currentTimeMillis()

        replaceOutputBuffer(remaining).put(inputBuffer).flip()
    }

    private fun ensureWorker() {
        if (worker != null) return
        val t = HandlerThread("rustify-spectrum")
        t.start()
        worker = t
        val h = Handler(t.looper)
        handler = h
        h.postDelayed(tick, HOP_MS)
    }

    private val tick = object : Runnable {
        override fun run() {
            handler?.postDelayed(this, HOP_MS)
            // Sem sink (webview sem listener) ou sem audio fresco: nada a fazer.
            if (SpectrumBus.sink == null) return
            if (System.currentTimeMillis() - lastSampleAtMs > STALE_MS) return

            synchronized(ring) {
                if (ringFilled < FFT_SIZE) return
                var src = ringPos - FFT_SIZE
                if (src < 0) src += RING_SIZE
                for (i in 0 until FFT_SIZE) {
                    re[i] = ring[(src + i) % RING_SIZE] * hann[i]
                    im[i] = 0f
                }
            }

            fft(re, im)
            val norm = 1.0f / FFT_SIZE
            for (i in 0 until NUM_BINS) {
                mags[i] = sqrt(re[i] * re[i] + im[i] * im[i]) * norm
            }

            val binHz = sampleRate.toFloat() / FFT_SIZE
            lowEnv = stepEnv(lowEnv, normalizeBand(meanBand(LOW_HZ_A, LOW_HZ_B, binHz)))
            midEnv = stepEnv(midEnv, normalizeBand(meanBand(MID_HZ_A, MID_HZ_B, binHz)))
            highEnv = stepEnv(highEnv, normalizeBand(meanBand(HIGH_HZ_A, HIGH_HZ_B, binHz)))

            SpectrumBus.emit(lowEnv, midEnv, highEnv)
        }
    }

    // ------------------------------------------------------------- analise

    private val re = FloatArray(FFT_SIZE)
    private val im = FloatArray(FFT_SIZE)
    private val mags = FloatArray(NUM_BINS)
    private val hann = FloatArray(FFT_SIZE) { i ->
        (0.5 * (1.0 - cos(2.0 * Math.PI * i / (FFT_SIZE - 1)))).toFloat()
    }
    private var lowEnv = 0f
    private var midEnv = 0f
    private var highEnv = 0f
    private val attackCoef = exp(-HOP_MS / 1000.0f / ENV_ATTACK_S)
    private val releaseCoef = exp(-HOP_MS / 1000.0f / ENV_RELEASE_S)

    private fun meanBand(hzA: Float, hzB: Float, binHz: Float): Float {
        val a = (hzA / binHz).toInt().coerceIn(1, NUM_BINS - 1)
        val b = (hzB / binHz).toInt().coerceIn(a + 1, NUM_BINS)
        var sum = 0f
        for (i in a until b) sum += mags[i]
        return sum / (b - a)
    }

    private fun normalizeBand(raw: Float): Float =
        (sqrt(raw) * BAND_GAIN).coerceIn(0f, 1f)

    private fun stepEnv(env: Float, target: Float): Float {
        val coef = if (target > env) attackCoef else releaseCoef
        return target + (env - target) * coef
    }

    /** Radix-2 iterativa in-place (Cooley-Tukey). FFT_SIZE e potencia de 2. */
    private fun fft(re: FloatArray, im: FloatArray) {
        val n = re.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j or bit
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * Math.PI / len
            val wr = cos(ang).toFloat()
            val wi = kotlin.math.sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var cr = 1f
                var ci = 0f
                for (k in 0 until len / 2) {
                    val ur = re[i + k]
                    val ui = im[i + k]
                    val vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
                    val vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
                    re[i + k] = ur + vr
                    im[i + k] = ui + vi
                    re[i + k + len / 2] = ur - vr
                    im[i + k + len / 2] = ui - vi
                    val ncr = cr * wr - ci * wi
                    ci = cr * wi + ci * wr
                    cr = ncr
                }
                i += len
            }
            len = len shl 1
        }
    }

    override fun onReset() {
        handler?.removeCallbacksAndMessages(null)
        worker?.quitSafely()
        worker = null
        handler = null
        lowEnv = 0f
        midEnv = 0f
        highEnv = 0f
        ringFilled = 0
        ringPos = 0
    }

    companion object {
        private const val FFT_SIZE = 2048
        private const val NUM_BINS = FFT_SIZE / 2
        private const val RING_SIZE = FFT_SIZE * 2
        private const val HOP_MS = 40L
        private const val STALE_MS = 150L
        private const val BAND_GAIN = 4.0f
        private const val ENV_ATTACK_S = 0.005f
        private const val ENV_RELEASE_S = 0.100f
        private const val LOW_HZ_A = 20f
        private const val LOW_HZ_B = 200f
        private const val MID_HZ_A = 200f
        private const val MID_HZ_B = 2_000f
        private const val HIGH_HZ_A = 2_000f
        private const val HIGH_HZ_B = 12_000f
    }
}
