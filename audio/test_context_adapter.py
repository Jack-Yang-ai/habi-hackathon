import unittest
import json

from audio.context_adapter import to_context_signals, chunk_recording_start, chunk_to_context_signals
from audio.fetch_models import LOCK


def report():
    return {"audio_sha256": "0" * 64, "segments": [
        {"text": "我要去吃饭了", "window_start_sec": 2.0, "window_end_sec": 4.5,
         "speech_vad_verified": True, "audio_rms": 0.02,
         "event_tag": "<|Speech|>", "language_tag": "<|zh|>", "emotion_tag": "<|NEUTRAL|>"}]}


class ContextAdapterTest(unittest.TestCase):
    def test_requires_real_capture_start_with_timezone(self):
        with self.assertRaises(ValueError):
            to_context_signals(report(), "2026-10-15T12:00:00")

    def test_timestamp_is_recording_start_plus_segment_end(self):
        signal = to_context_signals(report(), "2026-10-15T12:00:00+08:00")[0]
        self.assertEqual(signal["observedAt"], "2026-10-15T04:00:04.500Z")
        self.assertEqual(signal["speaker"], "unknown")
        self.assertEqual(signal["sourceContext"], "unknown")
        self.assertTrue(signal["dryRun"])
        self.assertEqual(signal["audioEvents"], [])
        self.assertEqual(signal["asrEvidence"]["eventTag"], "<|Speech|>")

    def test_speaker_self_requires_independent_evidence(self):
        with self.assertRaises(ValueError):
            to_context_signals(report(), "2026-10-15T00:00:00Z", speaker="self")

    def test_no_speech_no_signal(self):
        source = report()
        source["segments"][0]["speech_vad_verified"] = False
        self.assertEqual(to_context_signals(source, "2026-10-15T00:00:00Z"), [])
        source["segments"][0]["speech_vad_verified"] = True
        source["segments"][0]["audio_rms"] = 0
        self.assertEqual(to_context_signals(source, "2026-10-15T00:00:00Z"), [])

    def test_only_same_audio_and_overlapping_tagging_scores_are_used(self):
        tags = [
            {"audio_sha256": "1" * 64, "windows": [{"window_start_sec": 0, "window_end_sec": 10,
                                                      "scores": {"Chewing, mastication": 0.99}}]},
            {"audio_sha256": "0" * 64, "windows": [
                {"window_start_sec": 0, "window_end_sec": 10, "scores": {"Speech": 0.9}},
                {"window_start_sec": 10, "window_end_sec": 20, "scores": {"Music": 0.8}}]}]
        signal = to_context_signals(report(), "2026-10-15T00:00:00Z", tags)[0]
        self.assertEqual(signal["audioEvents"], [{"label": "Speech", "score": 0.9}])

    def test_signal_id_is_stable_for_retries(self):
        first = to_context_signals(report(), "2026-10-15T00:00:00Z")[0]
        second = to_context_signals(report(), "2026-10-15T00:00:00Z")[0]
        self.assertEqual(first["signalId"], second["signalId"])

    def test_public_fixture_cannot_be_promoted_to_user_conversation(self):
        source = report()
        source["audio_sha256"] = json.loads(LOCK.read_text())["assets"][0]["files"]["test_wavs/zh.wav"]["sha256"]
        signal = to_context_signals(source, "2026-10-15T00:00:00Z", speaker="self",
                                    source_context="user-conversation", speaker_evidence="unit-test")[0]
        self.assertEqual(signal["sourceContext"], "test-fixture")
        self.assertEqual(signal["speaker"], "unknown")

    def test_known_media_cannot_be_downgraded_by_unknown_default(self):
        source = report()
        source["source_context"] = "media"
        signal = to_context_signals(source, "2026-10-15T00:00:00Z")[0]
        self.assertEqual(signal["sourceContext"], "media")

    def test_continuous_chunk_time_uses_frame_offset_and_receipt_hash(self):
        receipt = {"schema_version": 1, "frame_offset": 160000, "frames": 160000,
                   "sample_rate": 16000, "channels": 1, "encoding": "pcm_s16le", "sha256": "0" * 64}
        start = chunk_recording_start("2026-10-15T12:00:00+08:00", receipt, "0" * 64)
        self.assertEqual(start, "2026-10-15T04:00:10Z")
        signal = to_context_signals(report(), start)[0]
        self.assertEqual(signal["observedAt"], "2026-10-15T04:00:14.500Z")
        with self.assertRaises(ValueError):
            chunk_recording_start(start, receipt, "1" * 64)

    def test_unsupported_receipt_audio_format_is_rejected(self):
        with self.assertRaises(ValueError):
            chunk_recording_start("2026-10-15T00:00:00Z", {"schema_version": 1, "sample_rate": 44100}, "0" * 64)

    def test_schema_two_uses_persisted_capture_anchor(self):
        receipt = {"schema_version": 2, "capture_started_at": "2026-10-15T00:00:00Z",
                   "frame_offset": 160000, "frames": 160000, "sample_rate": 16000,
                   "channels": 1, "encoding": "pcm_s16le", "sha256": "0" * 64}
        self.assertEqual(chunk_recording_start(None, receipt, "0" * 64), "2026-10-15T00:00:10Z")
        with self.assertRaises(ValueError):
            chunk_recording_start("2026-10-15T01:00:00Z", receipt, "0" * 64)

    def test_synthetic_recording_receipt_cannot_trigger_live_user_action(self):
        receipt = {"schema_version": 2, "capture_started_at": "2026-10-15T00:00:00Z",
                   "frame_offset": 0, "frames": 160000, "sample_rate": 16000,
                   "channels": 1, "encoding": "pcm_s16le", "sha256": "0" * 64,
                   "time_source": "synthetic_fixture"}
        signal = chunk_to_context_signals(report(), receipt, speaker="self",
                                          source_context="user-conversation", speaker_evidence="unit-test")[0]
        self.assertEqual(signal["sourceContext"], "test-fixture")
        self.assertEqual(signal["speaker"], "unknown")


if __name__ == "__main__":
    unittest.main()
