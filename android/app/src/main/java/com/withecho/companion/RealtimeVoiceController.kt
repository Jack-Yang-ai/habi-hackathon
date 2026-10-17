package com.withecho.companion

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

object RealtimeVoiceState {
    private var state = JSONObject().put("phase", "idle").put("wake_word", "哈比").put("command", "记录")
    @Synchronized fun set(value: JSONObject) { state = JSONObject(value.toString()) }
    @Synchronized fun json() = JSONObject(state.toString())
}

/** Reuses AudioRecord PCM. This worker never owns or opens a microphone. */
class RealtimeVoiceController(context: Context, private val sessionId: String,
    private val onCamera: (String) -> Boolean) {
    private val app = context.applicationContext
    private data class Frame(val samples: FloatArray, val start: Long, val timing: WaveChunkWriter.CaptureTiming)
    private val queue = ArrayBlockingQueue<Frame>(16)
    @Volatile private var active = true
    @Volatile private var engine: LocalInferenceEngine? = null
    private var worker: Thread? = null
    private val state = JSONObject().put("phase", "loading_models").put("wake_word", "哈比").put("command", "记录")
        .put("session_id", sessionId).put("kws_ready", false).put("asr_ready", false).put("microphone_count", 1)
        .put("processed_frames", 0).put("wake_count", 0).put("command_count", 0).put("dropped_packets", 0)

    fun setEngine(value: LocalInferenceEngine?) { engine = value; publish { put("asr_ready", value != null) } }
    fun start() { worker = Thread({ run() }, "HabiRealtimeWake").also { it.start() } }
    fun accept(bytes: ByteArray, count: Int, firstFrame: Long, timing: WaveChunkWriter.CaptureTiming) {
        if (!active || count <= 0) return
        val samples = FloatArray(count / 2) { i ->
            ((bytes[i * 2].toInt() and 255) or (bytes[i * 2 + 1].toInt() shl 8)).toShort() / 32768.0f
        }
        if (!queue.offer(Frame(samples, firstFrame, timing))) publish { put("dropped_packets", optInt("dropped_packets") + 1) }
    }
    fun stop() {
        active = false; engine = null; queue.clear(); worker?.interrupt()
        publish { put("phase", "stopping").put("asr_ready", false) }
    }
    private fun run() {
        var runtime: VoiceKwsRuntime? = null
        try {
            publish { put("phase", "loading_models") }
            runtime = VoiceKwsRuntime(app)
            publish { put("kws_ready", true).put("model", runtime.lock.getString("model")).put("phase", "listening") }
            while (active) {
                val frame = queue.poll(1, TimeUnit.SECONDS) ?: continue
                for (event in runtime.accept(frame.samples, frame.start)) {
                    if (!active) break
                    when (event.kind) {
                        "wake" -> publish { put("phase", "awaiting_command").put("last_wake", event.evidence).put("wake_count", optInt("wake_count") + 1) }
                        "ready", "expired", "discontinuity" -> publish { put("phase", "listening") }
                        "command" -> confirm(runtime, event, frame.timing)
                    }
                }
                if (frame.start / 16000 != (frame.start + frame.samples.size) / 16000)
                    publish { put("processed_frames", frame.start + frame.samples.size).put("queued_packets", queue.size) }
            }
        } catch (e: Throwable) {
            if (active) publish { put("phase", "failed").put("error", e.javaClass.simpleName + ": " + e.message) }
        } finally {
            runtime?.close()
            publish { put("kws_ready", false).put("asr_ready", false); if (optString("phase") != "failed") put("phase", "stopped") }
        }
    }
    private fun confirm(runtime: VoiceKwsRuntime, event: VoiceKwsEvent, timing: WaveChunkWriter.CaptureTiming) {
        val asr = engine
        if (asr == null) { runtime.finishAttempt(false, event.endFrame); publish { put("phase", "waiting_asr") }; return }
        val ageMs = (SystemClock.elapsedRealtimeNanos() - timing.elapsedRealtimeNs - event.endFrame * 62500L) / 1000000
        if (ageMs !in -1000..5000) { runtime.finishAttempt(false, event.endFrame); publish { put("phase", "listening").put("warning", "stale_voice_candidate") }; return }
        publish { put("phase", "confirming_command") }
        try {
            val result = verifyCandidate(runtime, event, asr)
            val samples = checkNotNull(event.samples)
            val wave = waveBytes(samples)
            val id = "phone-kws-" + VoiceKwsRuntime.hash("$sessionId|${event.startFrame}|${event.endFrame}|${VoiceKwsRuntime.hash(wave)}".toByteArray()).take(32)
            result.put("request_id", id).put("session_id", sessionId).put("frame_offset", event.startFrame).put("frames", samples.size)
                .put("capture_started_at", timing.startedAt.toString()).put("time_source", timing.source)
                .put("observed_at", timing.startedAt.plusNanos(event.endFrame * 62500L).toString())
                .put("audio_sha256", VoiceKwsRuntime.hash(wave)).put("audio_uploaded", false)
                .put("checked_elapsed_ms", SystemClock.elapsedRealtime()).put("candidate_age_ms", ageMs)
            val checkedAgeMs = (SystemClock.elapsedRealtimeNanos() - timing.elapsedRealtimeNs - event.endFrame * 62500L) / 1000000
            result.put("confirmed_candidate_age_ms", checkedAgeMs)
            if (!active || checkedAgeMs !in -1000..5000) {
                runtime.finishAttempt(false, event.endFrame)
                if (active) publish { put("phase", "listening").put("warning", "stale_voice_confirmation") }
                return
            }
            val directory = File(app.filesDir, "voice-commands").apply { mkdirs() }
            atomicBytes(File(directory, "$id.wav"), wave)
            var accepted = false
            if (result.getBoolean("command_verified") && active) accepted = onCamera(id)
            result.put("camera_request_accepted", accepted)
            atomicBytes(File(directory, "$id.json"), result.toString().toByteArray())
            publish { put("phase", if (accepted) "capture_requested" else "awaiting_command").put("last_command", result)
                if (accepted) put("command_count", optInt("command_count") + 1) }
            runtime.finishAttempt(accepted, event.endFrame)
        } catch (e: Exception) {
            runtime.finishAttempt(false, event.endFrame)
            if (active) publish { put("phase", "listening").put("last_error", e.javaClass.simpleName + ": " + e.message) }
        }
    }
    @Synchronized private fun publish(change: JSONObject.() -> Unit) {
        state.change(); state.put("updated_elapsed_ms", SystemClock.elapsedRealtime())
        RealtimeVoiceState.set(state)
        try { atomicBytes(File(app.filesDir,"voice-trigger-status.json"),state.toString().toByteArray()) } catch (_: Exception) { }
        app.sendBroadcast(Intent(RecordingService.STATUS).setPackage(app.packageName))
    }
    companion object {
        internal fun verifyCandidate(runtime: VoiceKwsRuntime, event: VoiceKwsEvent, asr: LocalInferenceEngine): JSONObject {
            val samples = checkNotNull(event.samples)
            val speech = runtime.speechFrames(samples)
            val result = if (speech >= 4000) asr.recognizeCommand(samples) else JSONObject().put("text", "").put("event", "vad_rejected")
            val strict = VoiceCameraCommands.matches(result.optString("text"))
            val acoustic = event.evidence.optBoolean("command_acoustic_confirmed") &&
                VoiceCameraCommands.matchesWithAcousticCommand(result.optString("text"))
            return result.put("kws", event.evidence).put("speech_vad_verified", speech >= 4000)
                .put("command_verified", speech >= 4000 && result.optString("event") == "<|Speech|>" && (strict || acoustic))
                .put("verification_route", if (strict) "exact_asr" else if (acoustic) "wake_and_record_kws_with_full_asr_grammar" else "rejected")
                .put("kws_model", runtime.lock.getString("model")).put("wake_word", "哈比").put("command", "记录")
        }
        internal fun waveBytes(samples: FloatArray): ByteArray {
            val b = ByteBuffer.allocate(44 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            b.put("RIFF".toByteArray()).putInt(b.capacity() - 8).put("WAVEfmt ".toByteArray()).putInt(16)
                .putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16)
                .put("data".toByteArray()).putInt(samples.size * 2)
            samples.forEach { b.putShort((it * 32768).toInt().coerceIn(-32768, 32767).toShort()) }
            return b.array()
        }
        private fun atomicBytes(file: File, bytes: ByteArray) {
            val pending = File(file.parentFile, file.name + ".pending")
            FileOutputStream(pending).use { it.write(bytes); it.fd.sync() }
            check(pending.renameTo(file)) { "voice_evidence_commit_failed" }
        }
    }
}
