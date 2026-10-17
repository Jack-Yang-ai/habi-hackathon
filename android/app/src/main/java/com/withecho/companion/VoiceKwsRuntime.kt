package com.withecho.companion

import android.content.Context
import com.k2fsa.sherpa.onnx.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.security.MessageDigest
import kotlin.math.max
import kotlin.math.min

internal data class VoiceKwsEvent(val kind: String, val evidence: JSONObject,
    val samples: FloatArray? = null, val startFrame: Long = 0, val endFrame: Long = 0)

/** Same detector for live PCM and explicitly side-effect-free file validation. */
internal class VoiceKwsRuntime(context: Context) : Closeable {
    val lock = JSONObject(context.assets.open("kws-lock.json").bufferedReader().use { it.readText() })
    private val root = File(context.filesDir, "local-models")
    private val kws: KeywordSpotter
    private val vad: Vad
    private var wakeStream: OnlineStream? = null
    private var commandStream: OnlineStream? = null
    private val wakeKeywords: String
    private var wakeOrigin = 0L
    private var commandOrigin = 0L
    private var commandEvidence: JSONObject? = null
    private var nextFrame = -1L
    private var ringFirst = 0L
    private val ring = FloatArray(RATE * 12)
    private var wake: JSONObject? = null
    private var wakeDetectedFrame = 0L
    private var wakeDeadline = 0L
    private var endpointHadSpeech = false
    private var endpointConfirmAt = Long.MAX_VALUE
    private var vadCursor = 0L
    private var cooldownUntil = 0L

    init {
        val files = lock.getJSONObject("files")
        for (name in listOf("encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt", "keywords.txt")) {
            val file = File(root, "kws/$name"); val spec = files.getJSONObject(name)
            check(file.isFile && file.length() == spec.getLong("bytes") && hash(file.readBytes()) == spec.getString("sha256")) { "kws_hash_mismatch:$name" }
        }
        wakeKeywords = File(root,"kws/keywords.txt").readText()
        // createStream(custom) appends the constructor's default keywords. Use
        // an empty default graph so the command stream contains only 记录.
        val emptyKeywords = File(context.cacheDir,"habi-kws-empty.txt").apply { writeText("") }
        kws = KeywordSpotter(config = KeywordSpotterConfig(
            modelConfig = OnlineModelConfig(transducer = OnlineTransducerModelConfig(
                encoder = File(root,"kws/encoder.int8.onnx").absolutePath,
                decoder = File(root,"kws/decoder.onnx").absolutePath,
                joiner = File(root,"kws/joiner.int8.onnx").absolutePath),
                tokens = File(root,"kws/tokens.txt").absolutePath, numThreads = 1, provider = "cpu", modelType = "zipformer2"),
            keywordsFile = emptyKeywords.absolutePath,
            keywordsScore = lock.getDouble("keywords_score").toFloat(),
            keywordsThreshold = lock.getDouble("keywords_threshold").toFloat(),
            maxActivePaths = lock.getInt("max_active_paths"),
            numTrailingBlanks = lock.getInt("num_trailing_blanks")))
        try {
            val file = File(root,"vad/silero_vad.onnx")
            check(hash(file.readBytes()) == "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6") { "command_vad_hash_mismatch" }
            vad = Vad(config = VadModelConfig(sileroVadModelConfig = SileroVadModelConfig(
                model = file.absolutePath, threshold = 0.5f, minSilenceDuration = 0.25f,
                minSpeechDuration = 0.25f, maxSpeechDuration = 12f), sampleRate = RATE, numThreads = 1, provider = "cpu"))
        } catch (e: Throwable) { kws.release(); throw e }
    }

    fun accept(samples: FloatArray, firstFrame: Long): List<VoiceKwsEvent> {
        require(samples.isNotEmpty() && firstFrame >= 0)
        val events = mutableListOf<VoiceKwsEvent>()
        if (nextFrame != firstFrame) {
            reset(firstFrame); ringFirst = firstFrame
            cooldownUntil = 0L
            if (nextFrame >= 0) events.add(VoiceKwsEvent("discontinuity", JSONObject()))
        }
        for (i in samples.indices) ring[((firstFrame + i) % ring.size).toInt()] = samples[i]
        nextFrame = firstFrame + samples.size
        ringFirst = max(ringFirst, nextFrame - ring.size)
        if (nextFrame < cooldownUntil) { reset(nextFrame); return events }
        if (cooldownUntil > 0) { cooldownUntil = 0; events.add(VoiceKwsEvent("ready", JSONObject())) }
        if (wake != null && nextFrame > wakeDeadline) {
            events.add(VoiceKwsEvent("expired", JSONObject(wake.toString()))); reset(nextFrame)
        }
        if (wake != null) {
            if (commandEvidence == null) {
                commandStream?.acceptWaveform(samples, RATE)
                decodeCommand()
            }
            feedEndpointVad()
            if (vad.isSpeechDetected()) endpointConfirmAt = Long.MAX_VALUE
            else if (endpointHadSpeech && endpointConfirmAt == Long.MAX_VALUE) endpointConfirmAt = nextFrame + RATE / 4
            if (endpointHadSpeech && nextFrame >= endpointConfirmAt) {
                endpointHadSpeech = false
                endpointConfirmAt = Long.MAX_VALUE
                val from = max(ringFirst, wakeDetectedFrame - RATE * 2L)
                events.add(VoiceKwsEvent("command", JSONObject().put("verification_trigger", "speech_endpoint_after_wake")
                    .put("detected_frame", nextFrame).put("wake", wake)
                    .put("command_acoustic_confirmed", commandEvidence != null)
                    .put("command_kws", commandEvidence ?: JSONObject.NULL), slice(from, nextFrame), from, nextFrame))
            }
            return events
        }
        if (wake == null) {
            val stream = wakeStream ?: kws.createStream(wakeKeywords).also { wakeStream = it; wakeOrigin = firstFrame }
            stream.acceptWaveform(samples, RATE)
            while (kws.isReady(stream)) {
                kws.decode(stream)
                val result = kws.getResult(stream)
                if (result.keyword.isNotEmpty()) {
                    // sherpa resets decoder timestamps after silence. Kotlin's
                    // result omits segment start_time, so only our PCM frame
                    // counter may anchor a clip or establish freshness.
                    wakeDetectedFrame = nextFrame
                    wake = evidence(result, wakeOrigin).put("detected_frame", nextFrame)
                    wakeDeadline = nextFrame + lock.getInt("wake_window_seconds") * RATE
                    events.add(VoiceKwsEvent("wake", JSONObject(wake.toString())))
                    vad.reset()
                    vadCursor = max(ringFirst, wakeDetectedFrame - RATE)
                    feedEndpointVad()
                    commandOrigin = max(ringFirst, wakeDetectedFrame - RATE * 2L)
                    commandStream = kws.createStream(lock.getString("command_tokens")).also {
                        it.acceptWaveform(slice(commandOrigin, nextFrame), RATE)
                    }
                    decodeCommand()
                    stream.release(); wakeStream = null
                    break
                }
            }
        }
        return events
    }

    private fun decodeCommand() {
        val stream = commandStream ?: return
        while (commandEvidence == null && kws.isReady(stream)) {
            kws.decode(stream)
            val result = kws.getResult(stream)
            if (result.keyword == lock.getString("command"))
                commandEvidence = evidence(result, commandOrigin).put("detected_frame", nextFrame)
        }
    }

    fun finishAttempt(accepted: Boolean, atFrame: Long) {
        if (accepted) {
            cooldownUntil = atFrame + lock.getInt("cooldown_seconds") * RATE
            reset(atFrame)
        }
        // A lone wake word leaves the original six-second window open. A later
        // 记录 is verified together with that wake word from the same PCM ring.
    }
    fun speechFrames(samples: FloatArray): Int {
        vad.reset(); var position = 0
        while (position < samples.size) {
            val window = FloatArray(512)
            samples.copyInto(window, 0, position, min(samples.size, position + 512)); vad.acceptWaveform(window); position += 512
        }
        vad.flush(); var frames = 0
        while (!vad.empty()) { frames += vad.front().samples.size; vad.pop() }
        return frames
    }
    private fun feedEndpointVad() {
        while (vadCursor + 512 <= nextFrame) {
            vad.acceptWaveform(slice(vadCursor, vadCursor + 512)); vadCursor += 512
            if (vad.isSpeechDetected()) endpointHadSpeech = true
            while (!vad.empty()) vad.pop()
        }
    }
    private fun slice(from: Long, to: Long): FloatArray {
        check(from >= ringFirst && to <= nextFrame && to > from && to - from <= ring.size) { "voice_ring_range" }
        return FloatArray((to - from).toInt()) { ring[((from + it) % ring.size).toInt()] }
    }
    private fun evidence(result: KeywordSpotterResult, origin: Long) = JSONObject().put("keyword", result.keyword)
        .put("tokens", JSONArray(result.tokens.toList())).put("token_timestamps_sec", JSONArray(result.timestamps.map { it.toDouble() }))
        .put("input_stream_frame_origin", origin).put("token_timestamps_are_segment_relative", true)
        .put("threshold", lock.getDouble("keywords_threshold")).put("domain_calibrated", false)
    private fun reset(atFrame: Long) {
        wakeStream?.release(); wakeStream = null; commandStream?.release(); commandStream = null
        commandEvidence = null
        wake = null; wakeOrigin = atFrame; endpointHadSpeech = false; endpointConfirmAt = Long.MAX_VALUE
    }
    override fun close() { reset(0); vad.release(); kws.release() }
    companion object {
        const val RATE = 16000
        fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
