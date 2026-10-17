package com.withecho.audio

import com.k2fsa.sherpa.onnx.*
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/** File-only test harness. No Android permissions, microphone, camera or network. */
object PublicAudioProbe {
    private fun memory(): JSONObject {
        val result = JSONObject()
        File("/proc/self/status").forEachLine { line ->
            if (line.startsWith("VmRSS:") || line.startsWith("VmHWM:")) {
                result.put(line.substringBefore(":"), line.substringAfter(":").trim())
            }
        }
        return result
    }

    @JvmStatic
    fun main(args: Array<String>) {
        require(args.size == 3) { "Usage: PublicAudioProbe <bundle-root> <sensevoice|tagging> <zh.wav|music.wav|cat.wav>" }
        val root = args[0]
        val mode = args[1]
        val sample = args[2]
        require(mode in setOf("sensevoice", "tagging"))
        require(sample in setOf("zh.wav", "music.wav", "cat.wav"))
        val wave = WaveReader.readWave("$root/samples/$sample")
        val duration = wave.samples.size.toDouble() / wave.sampleRate
        require(duration in 0.01..30.0) { "Only bounded public test fixtures are supported" }
        val report = JSONObject().put("schema_version", 1).put("mode", mode)
            .put("runtime", "sherpa-onnx-1.13.8-android-arm64")
            .put("provider", "cpu").put("threads", 2).put("fixture", sample)
            .put("audio_duration_sec", duration).put("speaker", "unknown")
            .put("subject", "unknown").put("microphone_started", false)
            .put("camera_started", false).put("network_used", false)
            .put("meal_created", false)
        val runs = JSONArray()
        val loadStart = System.nanoTime()
        if (mode == "sensevoice") {
            val modelRoot = "$root/models/sensevoice"
            val recognizer = OfflineRecognizer(config = OfflineRecognizerConfig(
                modelConfig = OfflineModelConfig(
                    senseVoice = OfflineSenseVoiceModelConfig(model = "$modelRoot/model.int8.onnx"),
                    tokens = "$modelRoot/tokens.txt", numThreads = 2, provider = "cpu", debug = false)))
            report.put("model_load_seconds", (System.nanoTime() - loadStart) / 1e9)
            try {
                repeat(3) {
                    val started = System.nanoTime()
                    val stream = recognizer.createStream()
                    try {
                        stream.acceptWaveform(wave.samples, wave.sampleRate)
                        recognizer.decode(stream)
                        val result = recognizer.getResult(stream)
                        val elapsed = (System.nanoTime() - started) / 1e9
                        runs.put(JSONObject().put("inference_seconds", elapsed)
                            .put("real_time_factor", elapsed / duration)
                            .put("text", result.text).put("language_tag", result.lang)
                            .put("emotion_tag", result.emotion).put("event_tag", result.event)
                            .put("tokens", JSONArray(result.tokens.toList()))
                            .put("token_timestamps_sec", JSONArray(result.timestamps.toList())))
                    } finally { stream.release() }
                }
                report.put("memory_before_release", memory())
            } finally { recognizer.release() }
        } else {
            val modelRoot = "$root/models/tagging"
            val tagger = AudioTagging(config = AudioTaggingConfig(
                model = AudioTaggingModelConfig(
                    zipformer = OfflineZipformerAudioTaggingModelConfig(model = "$modelRoot/model.int8.onnx"),
                    numThreads = 2, provider = "cpu", debug = false),
                labels = "$modelRoot/class_labels_indices.csv", topK = 527))
            report.put("model_load_seconds", (System.nanoTime() - loadStart) / 1e9)
            try {
                repeat(3) {
                    val started = System.nanoTime()
                    val stream = tagger.createStream()
                    try {
                        stream.acceptWaveform(wave.samples, wave.sampleRate)
                        val events = tagger.compute(stream, 527)
                        val elapsed = (System.nanoTime() - started) / 1e9
                        val top = JSONArray()
                        events.take(5).forEach { event -> top.put(JSONObject().put("label", event.name)
                            .put("index", event.index).put("score", event.prob.toDouble())) }
                        val relevant = JSONObject()
                        events.filter { it.name in setOf("Chewing, mastication", "Biting", "Speech", "Music") }
                            .forEach { relevant.put(it.name, it.prob.toDouble()) }
                        runs.put(JSONObject().put("inference_seconds", elapsed)
                            .put("real_time_factor", elapsed / duration).put("top_events", top)
                            .put("relevant_scores", relevant).put("scores_are_calibrated", false))
                    } finally { stream.release() }
                }
                report.put("memory_before_release", memory())
            } finally { tagger.release() }
        }
        report.put("runs", runs).put("memory_scope", "standalone_process_including_ART_and_native_runtime")
        println("AUDIO_PROBE_JSON=" + report.toString())
    }
}
