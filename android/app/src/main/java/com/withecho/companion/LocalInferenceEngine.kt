package com.withecho.companion

import android.content.Context
import com.k2fsa.sherpa.onnx.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.time.Instant
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** File-only, synchronous CPU inference. Call from the pipeline's worker, never the UI thread. */
class LocalInferenceEngine private constructor(private val root: File) : Closeable {
    constructor(context: Context) : this(File(context.applicationContext.filesDir, "local-models"))

    private var recognizer: OfflineRecognizer? = null
    private val recognizerLock = Any()
    private var vad: Vad? = null
    private var decider = 0L
    private var ready: JSONObject? = null
    private var historyCapture = ""
    private var lastOffset = -1L
    private val history = ArrayDeque<History>()
    private val completed = LinkedHashMap<String, JSONObject>()
    private data class History(val endFrame: Long, val text: String)

    @Synchronized fun prepare(): JSONObject {
        ready?.let { return JSONObject(it.toString()) }
        val start = System.nanoTime()
        try {
            EXPECTED.forEach { (name, expected) ->
                val file = File(root, name)
                check(file.isFile && file.length() == expected.first && sha256(file) == expected.second) {
                    "model_hash_mismatch:$name"
                }
            }
            vad = Vad(config = VadModelConfig(
                sileroVadModelConfig = SileroVadModelConfig(
                    model = File(root, "vad/silero_vad.onnx").absolutePath,
                    threshold = 0.5f, minSilenceDuration = 0.25f,
                    minSpeechDuration = 0.25f, windowSize = 512, maxSpeechDuration = 12f),
                sampleRate = RATE, numThreads = 1, provider = "cpu", debug = false))
            recognizer = OfflineRecognizer(config = OfflineRecognizerConfig(
                modelConfig = OfflineModelConfig(
                    senseVoice = OfflineSenseVoiceModelConfig(
                        model = File(root, "sensevoice/model.int8.onnx").absolutePath,
                        language = "auto", useInverseTextNormalization = true),
                    tokens = File(root, "sensevoice/tokens.txt").absolutePath,
                    numThreads = 2, provider = "cpu", debug = false)))
            decider = LocalDeciderNative.open(File(root, "decider/decider-0.8b-Q4_K_M.gguf").absolutePath.utf8(), 2)
            check(decider != 0L) { "decider_load_failed" }
            // Fail preparation if GGUF tokenization differs from locked HF-tokenizer vectors.
            val vectors = JSONObject(File(root, "tokenizer-vectors.json").readText()).getJSONArray("vectors")
            for (i in 0 until vectors.length()) {
                val item = vectors.getJSONObject(i)
                val actual = LocalDeciderNative.tokenize(decider, item.getString("text").utf8())
                val expected = item.getJSONArray("ids")
                check(actual.size == expected.length() && actual.indices.all { actual[it] == expected.getInt(it) }) {
                    "gguf_hf_tokenizer_mismatch:$i"
                }
            }
            val result = JSONObject().put("ready", true).put("runtime", runtime())
                .put("model_hashes", hashes()).put("model_directory", root.absolutePath)
                .put("load_ms", elapsed(start)).put("resident_models", JSONArray(listOf("silero-vad", "sensevoice-int8", "decider-0.8b-q4")))
                .put("cpu_threads", 2).put("n_ctx", 2048).put("n_seq_max", 1)
                .put("microphone_started", false).put("network_used", false)
                .put("tokenizer_hf_vectors_verified", true).put("prompt_version", PROMPT_VERSION)
            ready = result
            return JSONObject(result.toString())
        } catch (failure: Throwable) { close(); throw failure }
    }

    /** Times in segments are relative to this WAV. Receipt frame_offset maps them to the recording. */
    @Synchronized fun analyze(wav: File, receipt: JSONObject): JSONObject {
        prepare()
        val start = System.nanoTime()
        require(receipt.getInt("schema_version") == 2) { "receipt_schema_2_required" }
        require(receipt.getInt("sample_rate") == RATE && receipt.getInt("channels") == 1
            && receipt.getString("encoding") == "pcm_s16le") { "receipt_format_mismatch" }
        val offset = receipt.getLong("frame_offset")
        val capture = receipt.getString("capture_id")
        require(offset >= 0 && capture.isNotEmpty() && capture.length <= 120) { "invalid_capture_position" }
        val digest = sha256(wav)
        require(digest == receipt.getString("sha256")) { "wave_receipt_hash_mismatch" }
        require(!receipt.has("file") || receipt.getString("file") == wav.name) { "wave_receipt_filename_mismatch" }
        val key = "$capture:$offset:$digest"
        completed[key]?.let { return JSONObject(it.toString()).put("duplicate", true) }
        if (capture == historyCapture) require(offset > lastOffset) { "out_of_order_chunk" }
        else { history.clear(); completed.clear(); historyCapture = capture; lastOffset = -1 }
        val samples = readPcmWave(wav)
        require(samples.size.toLong() == receipt.getLong("frames")) { "wave_receipt_frames_mismatch" }
        require(samples.size <= RATE * 12) { "wave_too_long" }
        while (history.isNotEmpty() && offset - history.first().endFrame > RATE * 60L) history.removeFirst()
        val times = JSONObject()
        val testFixture = digest in PUBLIC_FIXTURE_HASHES || receipt.optString("time_source") == "synthetic_fixture"
        val result = JSONObject().put("schema_version", 1).put("audio_sha256", digest)
            .put("capture_id", capture).put("frame_offset", offset).put("sample_rate", RATE)
            .put("duration_sec", samples.size.toDouble() / RATE).put("runtime", runtime()).put("model_hashes", hashes())
            .put("speaker", "unknown").put("source_context", "unknown").put("duplicate", false)
            .put("test_fixture", testFixture)
            .put("timings_ms", times).put("speech_vad_verified", false).put("segments", JSONArray())
            .put("microphone_started", false).put("network_used", false).put("prompt_version", PROMPT_VERSION)
            .put("capture_started_at", receipt.opt("capture_started_at") ?: JSONObject.NULL)
            .put("time_source", receipt.opt("time_source") ?: JSONObject.NULL)
        var tick = System.nanoTime()
        val detector = checkNotNull(vad)
        detector.reset()
        var position = 0
        while (position < samples.size) {
            val window = FloatArray(512)
            samples.copyInto(window, 0, position, min(position + 512, samples.size))
            detector.acceptWaveform(window)
            position += 512
        }
        detector.flush()
        val ranges = JSONArray()
        var speechStart = samples.size
        var speechEnd = 0
        var speechFrames = 0
        while (!detector.empty()) {
            val segment = detector.front()
            val from = max(0, segment.start)
            val to = min(samples.size, segment.start + segment.samples.size)
            if (to > from) {
                ranges.put(JSONObject().put("start_sec", from.toDouble() / RATE).put("end_sec", to.toDouble() / RATE))
                speechStart = min(speechStart, from); speechEnd = max(speechEnd, to); speechFrames += to - from
            }
            detector.pop()
        }
        times.put("vad", elapsed(tick)).put("asr", 0).put("decider", 0)
        result.put("vad_ranges", ranges).put("vad_speech_seconds", speechFrames.toDouble() / RATE)
        if (speechFrames >= RATE / 4) {
            // Padding prevents clipping the first/last phoneme. Non-overlapping chunks
            // are never stitched as raw audio, so window timestamps remain exact.
            val from = max(0, speechStart - (RATE * 0.30).toInt())
            val to = min(samples.size, speechEnd + (RATE * 0.50).toInt())
            val rms = sqrt(samples.sliceArray(from until to).fold(0.0) { sum, sample -> sum + sample.toDouble() * sample } / (to - from))
            result.put("speech_window_rms", rms)
            if (rms < 0.0001) {
                result.put("suppressed_reason", "speech_window_below_rms_floor")
                lastOffset = offset; times.put("total", elapsed(start))
                completed[key] = JSONObject(result.toString())
                while (completed.size > 8) completed.remove(completed.keys.first())
                return result
            }
            tick = System.nanoTime()
            val decoded = recognize(samples.copyOfRange(from, to))
            times.put("asr", elapsed(tick))
            result.put("speech_vad_verified", true)
            result.put("asr_event_tag", decoded.event)
            // Matched against the real 1.13.8 phone result: <|Speech|>.
            // Other event labels never become semantic camera candidates.
            if (decoded.text.isNotBlank() && decoded.event == "<|Speech|>") {
                val previous = history.map { it.text }.takeLast(3)
                // A direct shutter command does not need the meal decision head.
                val directCamera = VoiceCameraCommands.matches(decoded.text)
                val decision = if (directCamera) null else classifyInternal(decoded.text, previous)
                times.put("decider", decision?.getDouble("wallMs") ?: 0.0)
                if (directCamera) result.put("decider_skipped", "explicit_camera_command")
                val item = JSONObject().put("text", decoded.text).put("window_start_sec", from.toDouble() / RATE)
                    .put("window_end_sec", to.toDouble() / RATE).put("language_tag", decoded.lang)
                    .put("emotion_tag", decoded.emotion).put("event_tag", decoded.event)
                    .put("speech_vad_verified", true).put("decision", decision)
                    .put("test_fixture", testFixture).put("speech_window_rms", rms)
                    .put("speaker", "unknown").put("source_context", "unknown")
                    .put("context_previous", JSONArray(previous)).put("context_window_sec", 60)
                    .put("observed_at", observedAt(receipt, offset + to))
                // SenseVoice timestamps are only retained if supplied by the model.
                item.put("asr_tokens", JSONArray(decoded.tokens.toList()))
                item.put("asr_token_timestamps_sec", JSONArray(decoded.timestamps.map { it.toDouble() + from.toDouble() / RATE }))
                result.getJSONArray("segments").put(item)
                history.addLast(History(offset + to, decoded.text))
                while (history.size > 3) history.removeFirst()
            } else result.put("suppressed_reason", if (decoded.text.isBlank()) "empty_asr_text" else "asr_event_not_speech")
        }
        lastOffset = offset
        times.put("total", elapsed(start))
        completed[key] = JSONObject(result.toString())
        while (completed.size > 8) completed.remove(completed.keys.first())
        return result
    }

    /** Public text fixtures and diagnostics only; no camera or network side effects. */
    @Synchronized fun classify(text: String, previous: List<String> = emptyList()): JSONObject {
        prepare()
        return classifyInternal(text, previous)
    }

    private fun classifyInternal(text: String, previous: List<String>): JSONObject {
        require(text.isNotBlank() && text.length <= 4000 && previous.size <= 3
            && previous.all { it.length <= 4000 }) { "decision_text_limit" }
        val context = "Previous: " + previous.joinToString(" | ") + "\nSpeaker: unknown\nSource: unknown\nMessage: " + text
        val tick = System.nanoTime()
        val probabilities = LocalDeciderNative.evaluate(decider, context.utf8(), QUESTION.utf8(), OPTIONS.map { it.second.utf8() }.toTypedArray())
        check(probabilities.size == OPTIONS.size && probabilities.all { it.isFinite() && it in 0.0..1.0 }) { "invalid_distribution" }
        val ranking = probabilities.indices.sortedByDescending { probabilities[it] }
        val distribution = JSONObject()
        OPTIONS.forEachIndexed { index, pair -> distribution.put(pair.first, probabilities[index]) }
        return JSONObject().put("stage", OPTIONS[ranking[0]].first).put("probability", probabilities[ranking[0]])
            .put("margin", probabilities[ranking[0]] - probabilities[ranking[1]]).put("distribution", distribution)
            .put("wallMs", elapsed(tick)).put("model", "decider-0.8b-q4").put("modelSha256", DECIDER_SHA)
            .put("runtime", "llama.cpp-android-cpu").put("temperature", 1.03)
            .put("promptTokens", LocalDeciderNative.lastTokenCount(decider)).put("promptVersion", PROMPT_VERSION)
            .put("domainCalibrated", false)
    }

    /** Shares only the ASR lock; a long Decider call cannot block a wake command. */
    fun recognizeCommand(samples: FloatArray): JSONObject {
        require(samples.size in (RATE / 4)..(RATE * 12)) { "command_audio_limit" }
        val tick = System.nanoTime()
        val result = recognize(samples)
        return JSONObject().put("text", result.text).put("event", result.event).put("language", result.lang)
            .put("asr_ms", elapsed(tick)).put("tokens", JSONArray(result.tokens.toList()))
    }

    private fun recognize(samples: FloatArray): OfflineRecognizerResult = synchronized(recognizerLock) {
        val asr = checkNotNull(recognizer) { "command_asr_not_ready" }
        val stream = asr.createStream()
        try { stream.acceptWaveform(samples, RATE); asr.decode(stream); asr.getResult(stream) }
        finally { stream.release() }
    }

    @Synchronized override fun close() {
        if (decider != 0L) { LocalDeciderNative.close(decider); decider = 0 }
        synchronized(recognizerLock) { recognizer?.release(); recognizer = null }
        vad?.release(); vad = null
        ready = null; history.clear(); completed.clear(); historyCapture = ""; lastOffset = -1
    }

    private fun observedAt(receipt: JSONObject, endFrame: Long): Any {
        if (!receipt.has("capture_started_at")) return JSONObject.NULL
        return try { Instant.parse(receipt.getString("capture_started_at")).plusNanos(endFrame * 62500L).toString() }
        catch (_: Exception) { JSONObject.NULL }
    }

    companion object {
        private const val RATE = 16000
        private const val DECIDER_SHA = "5cb5d042a236add5cde5459f8e8b8f8f80161ad4a1779a49377b70a64eb7b11a"
        private const val PROMPT_VERSION = "meal-short-english-v1-identity-unknown"
        private const val QUESTION = "What is the speaker's meal intent right now?"
        private val OPTIONS = listOf(
            "start_soon" to "Preparing to eat food right now or immediately.",
            "invited" to "An invitation to eat, not yet accepted.",
            "eating_now" to "Currently eating food.",
            "finished" to "Already finished eating.",
            "declined" to "Refusing or cancelling food.",
            "unrelated" to "Unrelated, other people, media, future or hypothetical meals.",
            "uncertain" to "Insufficient evidence of current eating intent.")
        private val EXPECTED = linkedMapOf(
            "sensevoice/model.int8.onnx" to (239233841L to "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"),
            "sensevoice/tokens.txt" to (315894L to "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"),
            "vad/silero_vad.onnx" to (643854L to "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"),
            "decider/decider-0.8b-Q4_K_M.gguf" to (529297504L to DECIDER_SHA),
            "tokenizer-vectors.json" to (3360L to "4b914d5eddc5d9cbf6f7873bdf93c373343813c3ffa0d49aa024692346542c6a"))
        private val PUBLIC_FIXTURE_HASHES = setOf(
            "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373",
            "0dc797a5c81ed30fc339d91f3da718ab02854e17ffa37cb93c4c039ac5c6bb9c",
            "460bd8dccb0d2a5f4e29c628f837be4082d13defc64c3fc21dd1b6bb0e119095",
            "eb1eb008904465b74c304aad8342e8c7d3c6e61ffe9f66adcaca9cf0f76a93f4",
            "0960b2db54ae202071d250e6462fbf74a3c863f0e3e7f01273e4939c996875a0",
            "ce16b2d9b657a68795d48aff8bba7ded5bb12f75ad30ed18e45e2d72e1c8f58c",
            "3e64664ba3af83a323b2f77749d2dcb9c1d9dbf0353fbe233fc025fb8e0c2145",
            "1ba3e55c71a822030c91533f703b44163eaa6daea253e9f1ab790b7ac0f2f153",
            "136702e1046ab39bd3ad0431a789325ca14459448388248fb75cb8c033ccb4ac",
            "a300cfdcc92cb35701a21fe89619a1a9d2d0ebc8bf168c03733f4cc365454612",
            "2466dcfe841ae2ac3763ac4e4c834a523b3111cdb3e667943af1ded57ced2021",
            "1de5ce1e5262140b0b800cc12bf635ccb5d0d54881385f4184cb6ab873676197",
            "836b2d550ada991c4efb84f14c880f8e49057e1fdd35b6e05732041aff8ccbc5",
            "d5d38fe922c4b70d24dfc4a400b1aafc10e44034cbfca4f9110fff195323c667",
            "a33d53dea1624b7411b4d88d9e3d5a4a632b6a6deb522ac3049643043545ee6b",
            "eba3340c61d0dfb0532bed52a9da7389912addc661707bbe588dbeb4a1d38c65",
            "a9c4665e36e990ff739beb1b7a96df403e2f031e96004626057c342eec986965",
            "6a1c8069cc932d29918be549d2bbe783dca4e6b4c2443bd23f6e526cb1f483e0")

        /** Explicit isolated public-file harness; never points at another app's data. */
        @JvmStatic fun forPublicFixture(modelRoot: File) = LocalInferenceEngine(modelRoot)
        private fun String.utf8() = toByteArray(Charsets.UTF_8)
        private fun elapsed(start: Long) = (System.nanoTime() - start) / 1e6
        private fun hashes(): JSONObject = JSONObject().also { out -> EXPECTED.forEach { (name, info) -> out.put(name, info.second) } }
        private fun runtime() = JSONObject().put("asr", "sherpa-onnx-1.13.8-ort-1.28.2-android-cpu")
            .put("decider", "llama.cpp-android-cpu").put("gpu_layers", 0).put("arm_arch", "armv8-a")
        private fun sha256(file: File): String {
            require(file.length() <= 600L * 1024 * 1024) { "file_too_large" }
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(1024 * 1024)
                while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
            }
            return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        }

        /** Bounded RIFF PCM16/16k/mono reader; accepts metadata chunks in public WAVs. */
        private fun readPcmWave(file: File): FloatArray {
            require(file.length() in 44..(RATE * 12L * 2 + 65536)) { "wave_size_limit" }
            val bytes = file.readBytes()
            val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            fun four(at: Int) = String(bytes, at, 4, Charsets.US_ASCII)
            require(four(0) == "RIFF" && four(8) == "WAVE" && b.getInt(4).toLong() + 8 == bytes.size.toLong()) { "invalid_riff" }
            var at = 12
            var formatOk = false
            var dataStart = -1
            var dataSize = 0
            while (at + 8 <= bytes.size) {
                val size = b.getInt(at + 4)
                require(size >= 0 && at.toLong() + 8 + size <= bytes.size) { "invalid_wave_chunk" }
                when (four(at)) {
                    "fmt " -> {
                        require(size >= 16) { "short_wave_format" }
                        formatOk = b.getShort(at + 8).toInt() == 1 && b.getShort(at + 10).toInt() == 1
                            && b.getInt(at + 12) == RATE && b.getShort(at + 20).toInt() == 2 && b.getShort(at + 22).toInt() == 16
                    }
                    "data" -> { require(dataStart < 0) { "multiple_wave_data_chunks" }; dataStart = at + 8; dataSize = size }
                }
                at += 8 + size + (size and 1)
            }
            require(formatOk && dataStart >= 0 && dataSize % 2 == 0 && dataSize <= RATE * 12 * 2) { "pcm16_16k_mono_required" }
            return FloatArray(dataSize / 2) { b.getShort(dataStart + it * 2) / 32768.0f }
        }
    }
}

/** Process-wide singleton is enforced in C++; all native calls share one mutex. */
internal object LocalDeciderNative {
    init { System.loadLibrary("echo-decider") }
    external fun open(pathUtf8: ByteArray, threads: Int): Long
    external fun evaluate(handle: Long, contextUtf8: ByteArray, questionUtf8: ByteArray, optionsUtf8: Array<ByteArray>): DoubleArray
    external fun tokenize(handle: Long, textUtf8: ByteArray): IntArray
    external fun lastTokenCount(handle: Long): Int
    external fun close(handle: Long)
}
