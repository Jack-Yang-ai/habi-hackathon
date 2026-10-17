package com.withecho.companion

import java.io.File
import java.security.MessageDigest
import org.json.JSONObject
import org.json.JSONArray

/** Public, file-only fixture runner. No microphone, camera, permissions, HTTP or app data. */
object LocalInferencePublicProbe {
    @JvmStatic fun main(args: Array<String>) {
        require(args.size == 1) { "Expected isolated public bundle directory" }
        val root = File(args[0])
        require(root.absolutePath.startsWith("/data/local/tmp/echo-local-public-")) { "public_fixture_directory_required" }
        val engine = LocalInferenceEngine.forPublicFixture(File(root, "models"))
        val report = JSONObject().put("schema_version", 1).put("fixture_only", true)
            .put("microphone_started", false).put("private_audio_read", false)
            .put("camera_started", false).put("network_used", false).put("meal_created", false)
        try {
            report.put("prepare", engine.prepare())
            val results = JSONArray()
            var offset = 0L
            for ((sequence, name) in listOf("zh.wav", "silence.wav").withIndex()) {
                val wave = File(root, "samples/$name")
                val hash = MessageDigest.getInstance("SHA-256").digest(wave.readBytes()).joinToString("") { "%02x".format(it.toInt() and 255) }
                val frames = if (name == "zh.wav") 89472 else 160000
                val receipt = JSONObject().put("schema_version", 2).put("capture_id", "public-fixture-only")
                    .put("sequence", sequence).put("frame_offset", offset).put("frames", frames)
                    .put("sample_rate", 16000).put("channels", 1).put("encoding", "pcm_s16le")
                    .put("sha256", hash).put("file", name).put("capture_started_at", "2000-01-01T00:00:00Z")
                    .put("time_source", "synthetic_fixture")
                val result = engine.analyze(wave, receipt).put("fixture", name)
                if (name == "zh.wav") {
                    check(result.getJSONArray("segments").length() > 0) { "public_speech_not_decoded" }
                    val duplicate = engine.analyze(wave, receipt)
                    check(duplicate.getBoolean("duplicate")) { "duplicate_not_suppressed" }
                    report.put("duplicate_suppressed", true)
                } else {
                    check(!result.getBoolean("speech_vad_verified") && result.getJSONArray("segments").length() == 0) { "silence_triggered_inference" }
                }
                results.put(result)
                offset += frames
            }
            report.put("audio_results", results)
            val text = JSONArray()
            for (message in listOf("我要去吃饭了", "你要不要吃？", "今天天气不错")) {
                text.put(JSONObject().put("text", message).put("decision", engine.classify(message)))
            }
            report.put("text_fixture_results", text)
            val memory = JSONObject()
            File("/proc/self/status").forEachLine { line ->
                if (line.startsWith("VmHWM:") || line.startsWith("VmRSS:")) memory.put(line.substringBefore(":"), line.substringAfter(":").trim())
            }
            report.put("memory", memory).put("completed", true)
            println("LOCAL_INFERENCE_PUBLIC_JSON=" + report.toString())
        } finally { engine.close() }
    }
}
