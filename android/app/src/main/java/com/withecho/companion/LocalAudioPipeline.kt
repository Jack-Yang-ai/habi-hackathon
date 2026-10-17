package com.withecho.companion

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/** One model worker consumes only committed WAVs from the current microphone session. */
class LocalAudioPipeline(context: Context, private val sessionId: String,
    private val onEngineReady: (LocalInferenceEngine?) -> Unit = {},
    private val cameraOwnedByRealtime: Boolean = false,
    private val onCameraCommand: (String) -> Boolean = { false }) {
    private val app = context.applicationContext
    private val queue = ArrayBlockingQueue<Chunk>(6)
    @Volatile private var active = true
    @Volatile private var finished = false
    @Volatile private var inFlight: HttpURLConnection? = null
    private val history = ArrayDeque<Pair<Instant, String>>()
    private var worker: Thread? = null
    private val publicationLock = Any()
    private data class Chunk(val wave: File, val receipt: JSONObject)

    fun start() {
        PipelineState.reset(sessionId)
        worker = Thread({ run() }, "EchoLocalInference").also { it.start() }
    }

    @Synchronized fun accept(wave: File, receipt: JSONObject) {
        if (!active || receipt.optString("capture_id") != sessionId) return
        if (!queue.offer(Chunk(wave, JSONObject(receipt.toString())))) {
            PipelineState.update { put("dropped_chunks", optInt("dropped_chunks") + 1).put("warning", "inference_queue_full_audio_preserved") }
        }
        PipelineState.update { put("queued_chunks", queue.size) }
    }

    @Synchronized fun stop() {
        if (!active) return
        active = false
        queue.clear()
        worker?.interrupt()
        PipelineState.update { put("phase", if (finished) "stopped" else "stopping").put("queued_chunks", 0).put("remote_pause", "pending") }
        app.sendBroadcast(Intent(RecordingService.STATUS).setPackage(app.packageName))
        Thread({
            inFlight?.disconnect()
            try {
                request("/api/device/pause", JSONObject().put("paused", true), allowStopped = true)
                PipelineState.update { put("remote_pause", "confirmed") }
            } catch (_: Exception) { PipelineState.update { put("remote_pause", "network_unavailable_window_expires") } }
            publish()
        }, "EchoStopCapture").start()
    }

    private fun run() {
        var engine: LocalInferenceEngine? = null
        try {
            PipelineState.update { put("phase", "loading_models") }
            publish()
            engine = LocalInferenceEngine(app)
            val prepared = engine.prepare()
            if (!active) return
            onEngineReady(engine)
            PipelineState.update { put("models", prepared).put("models_ready", true).put("phase", "listening") }
            publish()
            try {
                request("/api/device/pause", JSONObject().put("paused", false))
                PipelineState.update { put("automatic_capture", "enabled") }
            } catch (_: Exception) { PipelineState.update { put("automatic_capture", "backend_unreachable") } }
            while (active) {
                val chunk = queue.poll(1, TimeUnit.SECONDS) ?: continue
                if (!active) break
                PipelineState.update { put("phase", "processing").put("queued_chunks", queue.size) }
                publish()
                try {
                    check(chunk.wave.canonicalFile.parentFile == File(app.filesDir, "recordings/$sessionId").canonicalFile) { "unexpected_audio_directory" }
                    check(chunk.wave.name == chunk.receipt.getString("file") && chunk.wave.length() == chunk.receipt.getLong("bytes")) { "audio_receipt_mismatch" }
                    val report = engine.analyze(chunk.wave, chunk.receipt)
                    check(report.getString("audio_sha256") == chunk.receipt.getString("sha256")) { "audio_hash_mismatch" }
                    if (!active) break
                    if (report.optBoolean("duplicate")) {
                        PipelineState.update { put("phase", "listening") }
                        publish()
                        continue
                    }
                    val segments = report.optJSONArray("segments") ?: JSONArray()
                    val responses = JSONArray()
                    for (index in 0 until segments.length()) {
                        if (!active) break
                        val segment = segments.getJSONObject(index)
                        if (!segment.optBoolean("speech_vad_verified") || segment.optString("text").isBlank()) continue
                        val signal = signalFor(chunk.receipt, segment, index)
                        PipelineState.update { put("last_transcript", signal.getString("text")).put("last_decision", segment.optJSONObject("decision")) }
                        if (!active) break
                        val response = submit(signal)
                        responses.put(JSONObject().put("signalId", signal.getString("signalId")).put("result", response))
                    }
                    report.put("signal_results", responses).put("audio_uploaded", false)
                    atomicWrite(File(chunk.wave.parentFile, chunk.wave.nameWithoutExtension + ".inference.json"), report)
                    PipelineState.update { put("processed_chunks", optInt("processed_chunks") + 1).put("last_timings_ms", report.optJSONObject("timings_ms")) }
                } catch (failure: Exception) {
                    if (!active) break
                    PipelineState.update { put("last_error", failure.javaClass.simpleName + ": " + failure.message).put("failed_chunks", optInt("failed_chunks") + 1) }
                }
                if (active) PipelineState.update { put("phase", "listening") }
                publish()
            }
        } catch (failure: Throwable) {
            if (active) PipelineState.update { put("phase", "failed").put("last_error", failure.javaClass.simpleName + ": " + failure.message) }
        } finally {
            onEngineReady(null)
            try { engine?.close() } catch (_: Exception) { }
            finished = true
            PipelineState.update { put("models_ready", false).put("queued_chunks", 0); if (optString("phase") != "failed") put("phase", "stopped") }
            publish()
        }
    }

    private fun signalFor(receipt: JSONObject, segment: JSONObject, index: Int): JSONObject {
        val start = segment.getDouble("window_start_sec")
        val end = segment.getDouble("window_end_sec")
        check(start >= 0 && end > start && end <= receipt.getLong("frames") / 16000.0 + 0.001) { "invalid_asr_window" }
        val observed = Instant.parse(receipt.getString("capture_started_at"))
            .plusNanos(receipt.getLong("frame_offset") * 62500L + (end * 1e9).toLong())
        while (history.isNotEmpty() && history.first().first.isBefore(observed.minusSeconds(120))) history.removeFirst()
        val previous = JSONArray(history.takeLast(8).map { it.second })
        val text = segment.getString("text").take(3000)
        val id = sha256("$sessionId|${receipt.getLong("frame_offset")}|${receipt.getString("sha256")}|$index|$start|$end|$text")
        val decision = segment.optJSONObject("decision")
        check(decision != null || VoiceCameraCommands.matches(text)) { "missing_phone_decider_result" }
        val signal = JSONObject().put("signalId", "phone-audio-" + id.take(32)).put("text", text)
            .put("speaker", "unknown").put("sourceContext", "unknown").put("observedAt", observed.toString())
            .put("recentUtterances", previous).put("audioEvents", JSONArray()).put("localDecision", decision)
            .put("asrEvidence", JSONObject().put("audioSha256", receipt.getString("sha256"))
                .put("captureId", sessionId).put("captureStartedAt", receipt.getString("capture_started_at"))
                .put("frameOffset", receipt.getLong("frame_offset")).put("frames", receipt.getLong("frames"))
                .put("sampleRate", 16000).put("timeSource", receipt.getString("time_source"))
                .put("windowStartSec", start).put("windowEndSec", end).put("speechVadVerified", true)
                .put("languageTag", segment.opt("language_tag") ?: JSONObject.NULL)
                .put("emotionTag", segment.opt("emotion_tag") ?: JSONObject.NULL)
                .put("eventTag", segment.opt("event_tag") ?: JSONObject.NULL))
            .put("dryRun", false)
        // Public and synthetic fixture audio never becomes a live camera instruction.
        if (receipt.optString("time_source") == "synthetic_fixture" || segment.optBoolean("test_fixture")) signal.put("sourceContext", "test-fixture")
        history.addLast(observed to text.take(500))
        while (history.size > 8) history.removeFirst()
        return signal
    }

    private fun submit(signal: JSONObject): JSONObject {
        var last: Exception? = null
        val observed = Instant.parse(signal.getString("observedAt"))
        for (attempt in 0..2) {
            if (!active) return JSONObject().put("status", "cancelled")
            if (Instant.now().isAfter(observed.plusSeconds(120))) return JSONObject().put("status", "expired_without_trigger")
            try {
                val response = request("/api/signals/context", signal)
                if (!active) return JSONObject().put("status", "stopped_after_request")
                val result = response.getJSONObject("signal")
                if (result.optString("action") == "phone_capture" && active && cameraOwnedByRealtime) {
                    PipelineState.update { put("camera_execution", "realtime_kws_only_batch_is_context") }
                } else if (result.optString("action") == "phone_capture" && active) {
                    val accepted = onCameraCommand(signal.getString("signalId"))
                    PipelineState.update { put("last_camera_command", JSONObject().put("signalId", signal.getString("signalId"))
                        .put("accepted", accepted).put("reason", if (accepted) "one_phone_photo_requested" else "camera_busy_or_disarmed")) }
                }
                PipelineState.update {
                    put("submitted_signals", optInt("submitted_signals") + 1).put("last_signal", result).remove("last_network_error")
                    if (result.optString("stage") in setOf("start_soon", "invited", "eating_now") || result.optString("action") == "capture_window")
                        put("last_meal_signal", result)
                }
                return result
            } catch (failure: Exception) {
                last = failure
                PipelineState.update { put("last_network_error", failure.javaClass.simpleName + ": " + failure.message) }
                if (attempt < 2 && active) Thread.sleep((attempt + 1) * 1000L)
            }
        }
        // WAV and inference record remain local; this session does not replay stale commands on restart.
        return JSONObject().put("status", "not_delivered").put("error", last?.javaClass?.simpleName)
    }

    private fun request(path: String, payload: JSONObject, allowStopped: Boolean = false): JSONObject {
        val prefs = app.getSharedPreferences("native_pipeline", Context.MODE_PRIVATE)
        val base = URI(prefs.getString("backend_url", "http://127.0.0.1:8787")!!)
        check(base.scheme in setOf("http", "https") && base.host != null && base.userInfo == null) { "invalid_backend_url" }
        val url = base.resolve(path).toURL()
        val connection = url.openConnection() as HttpURLConnection
        if (!allowStopped) inFlight = connection
        try {
            connection.requestMethod = "POST"; connection.connectTimeout = 2500; connection.readTimeout = 5000
            connection.instanceFollowRedirects = false; connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            val token = prefs.getString("app_token", "").orEmpty()
            if (token.isNotEmpty()) connection.setRequestProperty("X-App-Token", token)
            CookieManager.getInstance().getCookie(base.resolve("/").toString())?.let { connection.setRequestProperty("Cookie", it) }
            val data = payload.toString().toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(data.size)
            check(active || allowStopped) { "pipeline_stopped" }
            connection.outputStream.use { it.write(data) }
            val code = connection.responseCode
            check(code in 200..299) { "backend_http_$code" }
            return connection.inputStream.bufferedReader().use { reader ->
                val chars = CharArray(1024 * 1024 + 1)
                var count = 0
                while (count < chars.size) { val n = reader.read(chars, count, chars.size - count); if (n < 0) break; count += n }
                check(count <= 1024 * 1024) { "backend_response_too_large" }
                JSONObject(String(chars, 0, count))
            }
        } finally { connection.disconnect(); if (!allowStopped && inFlight === connection) inFlight = null }
    }

    private fun publish() {
        synchronized(publicationLock) {
            try { atomicWrite(File(app.filesDir, "pipeline-status.json"), PipelineState.json()) } catch (_: Exception) { }
        }
        app.sendBroadcast(Intent(RecordingService.STATUS).setPackage(app.packageName))
    }

    private fun atomicWrite(file: File, value: JSONObject) {
        val temporary = File(file.parentFile, file.name + ".pending")
        FileOutputStream(temporary).use { it.write(value.toString().toByteArray(Charsets.UTF_8)); it.fd.sync() }
        check(temporary.renameTo(file)) { "pipeline_state_commit_failed" }
    }

    private fun sha256(text: String): String = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
}

object PipelineState {
    private var state = JSONObject().put("phase", "idle").put("models_ready", false)
    @Synchronized fun reset(sessionId: String) {
        state = JSONObject().put("phase", "starting").put("capture_id", sessionId).put("models_ready", false)
            .put("processed_chunks", 0).put("submitted_signals", 0).put("failed_chunks", 0)
            .put("dropped_chunks", 0).put("queued_chunks", 0).put("audio_uploaded", false)
            .put("asr", "sensevoice-int8-android").put("decider", "decider-0.8b-q4")
    }
    @Synchronized fun update(change: JSONObject.() -> Unit) { state.change(); state.put("updated_elapsed_ms", SystemClock.elapsedRealtime()) }
    @Synchronized fun json(): JSONObject = JSONObject(state.toString())
}
