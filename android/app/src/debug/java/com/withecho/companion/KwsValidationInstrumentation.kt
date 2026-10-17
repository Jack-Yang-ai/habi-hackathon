package com.withecho.companion

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Explicit local replay only. No AudioRecord, phone photo, upload or live state writes. */
class KwsValidationInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val output = Bundle()
        var runtime: VoiceKwsRuntime? = null
        var engine: LocalInferenceEngine? = null
        try {
            val bytes = File(targetContext.filesDir, "kws-validation/command.wav").readBytes()
            val raw = readWave(bytes)
            val repeatedBytes = File(targetContext.filesDir, "kws-validation/repeated-wake.wav").readBytes()
            val repeated = readWave(repeatedBytes)
            engine = LocalInferenceEngine(targetContext).also { it.prepare() }
            runtime = VoiceKwsRuntime(targetContext)
            val cases = JSONArray()
            val tick = System.nanoTime()
            // The split is specific to this explicitly supplied fixture. It removes
            // 记录 from wake-only and 哈比 from command-only; never used by live code.
            for ((name, input) in listOf("full" to raw, "full_after_8s_silence" to (FloatArray(128000)+raw),
                "full_repeated_wake" to repeated, "full_twice_in_cooldown" to (raw+FloatArray(8000)+raw),
                "full_with_2s_gap" to (raw.copyOfRange(0,minOf(34240,raw.size))+FloatArray(32000)+raw.copyOfRange(minOf(34240,raw.size),raw.size)),
                "expired_7s_gap" to (raw.copyOfRange(0,minOf(34240,raw.size))+FloatArray(112000)+raw.copyOfRange(minOf(34240,raw.size),raw.size)),
                "wake_only" to raw.copyOfRange(0,minOf(34240,raw.size)),
                "command_only" to raw.copyOfRange(minOf(34240,raw.size),raw.size), "silence" to FloatArray(128000))) {
                val events = JSONArray()
                val samples = input + FloatArray(16000) // synthetic tail to flush streaming model
                var at = 0
                var verified = 0
                while (at < samples.size) {
                    val end = minOf(at+2048,samples.size)
                    for (event in runtime.accept(samples.copyOfRange(at,end),at.toLong())) {
                        val item = JSONObject().put("kind",event.kind).put("evidence",event.evidence)
                        if (event.kind=="command") {
                            val result=RealtimeVoiceController.verifyCandidate(runtime,event,engine)
                            if (result.optBoolean("command_verified")) verified++
                            item.put("verification",result).put("clip_start_frame",event.startFrame).put("clip_end_frame",event.endFrame)
                            runtime.finishAttempt(result.optBoolean("command_verified"),event.endFrame)
                        }
                        events.put(item)
                    }
                    at=end
                }
                cases.put(JSONObject().put("name",name).put("events",events).put("verified_commands",verified)
                    .put("passed", if (name.startsWith("full")) verified==1 else verified==0))
            }
            val report = JSONObject().put("source","user-authorized-file-replay").put("test_fixture",true)
                .put("microphone_started",false).put("camera_started",false).put("network_used",false)
                .put("input_sha256",VoiceKwsRuntime.hash(bytes)).put("input_frames",raw.size).put("synthetic_tail_frames",16000)
                .put("repeated_wake_sha256",VoiceKwsRuntime.hash(repeatedBytes))
                .put("wall_ms",(System.nanoTime()-tick)/1e6).put("cases",cases)
            File(targetContext.filesDir,"kws-validation/result.json").writeText(report.toString())
            output.putString("report",report.toString())
            finish(if ((0 until cases.length()).all { cases.getJSONObject(it).getBoolean("passed") }) Activity.RESULT_OK else Activity.RESULT_CANCELED,output)
        } catch (e:Throwable) {
            output.putString("error",e.javaClass.simpleName+": "+e.message);finish(Activity.RESULT_CANCELED,output)
        } finally { runtime?.close();engine?.close() }
    }
    private fun readWave(bytes: ByteArray): FloatArray {
        check(bytes.size in 44..400000 && String(bytes,0,4)=="RIFF")
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        check(buffer.getInt(24)==16000 && buffer.getShort(22).toInt()==1 && buffer.getShort(34).toInt()==16)
        return FloatArray((bytes.size-44)/2) { buffer.getShort(44+it*2)/32768.0f }
    }
}
