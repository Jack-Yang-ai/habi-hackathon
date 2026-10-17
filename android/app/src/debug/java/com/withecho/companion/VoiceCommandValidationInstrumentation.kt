package com.withecho.companion

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle

/** Tests the actual Android matcher; no audio, camera, network or user files. */
class VoiceCommandValidationInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val result = Bundle()
        try {
            val accepted = listOf("Habi记录", "哈比记录。", "habi 记录", "HABI，记录！", "happy记录.", "HAPPY，记录！")
            val rejected = listOf("happy", "happy birthday记录", "记录", "拍照", "帮我拍一下", "不要Habi记录",
                "别哈比记录", "他说Habi记录", "明天Habi记录", "不要happy记录", "他说happy记录", "测试happy记录", "happy记录是什么意思")
            accepted.forEach { check(VoiceCameraCommands.matches(it)) { "strict should accept: $it" } }
            rejected.forEach { check(!VoiceCameraCommands.matches(it)) { "strict should reject: $it" } }
            // Acoustic evidence already confirmed both KWS words in this PCM, so only the command
            // word is read from the ASR text. The wake word was transcribed as 哈比, 海比, 还彼,
            // 阿皮, h皮 and 他比 within one afternoon while 记录 stayed correct.
            val acousticAccepted = listOf("记录", "记录。", "基录", "纪录", "之录", "之路", "记路",
                "哈比记录", "海比记录。", "还彼记录", "哈y记录", "哈比纪录",
                "哈比之录。", "海比之录", "哈比之路。", "海比之路", "哈比记路",
                "h皮记录。", "阿p之路。", "阿皮记录", "h比记录", "他比记录。")
            val acousticRejected = listOf("哈比", "哈比哈比", "不要哈比记录", "别哈比基录", "他说哈比记录", "明天哈比记录",
                "哈比明天记录", "哈比不要记录", "哈比基录是什么意思", "测试哈比基录", "happy birthday记录", "记录一下", "哈比哈比哈比哈比记录",
                // A repeated wake word puts four characters before the command, which is past the
                // bound; only the boundary matters here, not the words.
                "哈比哈比基录。")
            acousticAccepted.forEach { check(VoiceCameraCommands.matchesWithAcousticCommand(it)) { "acoustic grammar should accept: $it" } }
            acousticRejected.forEach { check(!VoiceCameraCommands.matchesWithAcousticCommand(it)) { "acoustic grammar should reject: $it" } }
            // These spellings cannot bypass the ordinary API/ASR matcher.
            listOf("哈比哈比基录", "海比记录", "还彼记录", "记录", "哈比纪录").forEach { check(!VoiceCameraCommands.matches(it)) { "must not bypass the ordinary matcher: $it" } }
            result.putInt("accepted_cases", accepted.size)
            result.putInt("rejected_cases", rejected.size)
            result.putInt("acoustic_grammar_accepted", acousticAccepted.size)
            result.putInt("acoustic_grammar_rejected", acousticRejected.size)
            result.putBoolean("microphone_started", false)
            result.putBoolean("camera_started", false)
            result.putBoolean("private_audio_read", false)
            finish(Activity.RESULT_OK, result)
        } catch (e: Throwable) {
            result.putString("error", e.javaClass.simpleName + ": " + e.message)
            finish(Activity.RESULT_CANCELED, result)
        }
    }
}
