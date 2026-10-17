package com.withecho.companion

/** Whole-utterance grammar for the spoken camera command; the raw ASR text is preserved as evidence. */
object VoiceCameraCommands {
    // Only these three spellings pass the ordinary matcher, which has no acoustic evidence behind it.
    private const val CANONICAL_WAKE = "habi|哈比|happy"
    // SenseVoice renders the neutral-tone ji of 记录 as homophones: 之路 and 之录 were both observed
    // on this device for a spoken 记录.
    private const val COMMAND = "记录|基录|纪录|之录|之路|记路"

    fun matches(text: String): Boolean {
        val compact = compact(text)
        // Observed SenseVoice spelling of Habi; not a general "happy" hotword.
        return Regex("^(?:$CANONICAL_WAKE)记录$").matches(compact)
    }

    /** Used only when the current live PCM independently matched both KWS words.
     *
     * That acoustic evidence is the gate: the wake word and the command were both heard in this PCM.
     * The ASR text is then asked one question only — does this utterance end in the command word,
     * with nothing before it and nothing after it?
     *
     * The wake word is deliberately not spelled out. One afternoon produced 哈比, 海比, 还彼, 阿皮,
     * h皮 and 他比 for the same spoken wake word, while 记录 was transcribed correctly every time:
     * requiring the ASR to spell the wake word let an unreliable signal veto a reliable one. What is
     * kept is its position and length - at most two leading characters, every rendering observed was
     * exactly two - so 他说哈比记录, 明天哈比记录 and 哈比不要记录 stay refused.
     */
    internal fun matchesWithAcousticCommand(text: String): Boolean =
        Regex("^.{0,2}(?:$COMMAND)$").matches(compact(text))

    private fun compact(text: String) = text.replace(Regex("[\\s，,。.!！?？、：:]"), "").lowercase()
}
