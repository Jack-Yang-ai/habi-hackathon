"""Policy tests use synthetic score fixtures, not real eating-detection validation."""

import unittest

from audio.eating_gate import AcousticWindow, EatingCandidateGate


def window(start, **kw):
    return AcousticWindow(start, start + 10, kw.pop("scores", {"Chewing, mastication": 0.8}), **kw)


class GateTest(unittest.TestCase):
    def test_three_independent_windows_only_emit_candidate(self):
        gate = EatingCandidateGate()
        self.assertEqual(gate.consume(window(0))["state"], "unknown")
        self.assertEqual(gate.consume(window(10))["state"], "unknown")
        result = gate.consume(window(20))
        self.assertEqual(result["state"], "eating_candidate")
        self.assertEqual(result["action_recommendation"], "capture_window")
        self.assertEqual(result["subject"], "unknown")
        self.assertFalse(result["meal_confirmed"])
        self.assertFalse(result["camera_started"])
        self.assertIsNone(result["calories"])

    def test_speech_and_music_are_negative_confounds(self):
        for label, score in [("Speech", 0.9), ("Music", 0.9)]:
            gate = EatingCandidateGate()
            for i in range(10):
                result = gate.consume(window(i * 10, scores={"Chewing, mastication": 0.9, label: score}))
                self.assertEqual(result["state"], "unknown")

    def test_explicit_media_and_other_person_are_excluded(self):
        for source in ["media", "tv", "test_media", "other_person"]:
            gate = EatingCandidateGate()
            for i in range(3):
                self.assertEqual(gate.consume(window(i * 10, source_context=source))["reason"], "excluded_source")

    def test_pause_resets_streak(self):
        gate = EatingCandidateGate()
        gate.consume(window(0))
        self.assertEqual(gate.consume(window(10, paused=True))["reason"], "user_paused")
        self.assertEqual(gate.consume(window(20))["state"], "unknown")
        self.assertEqual(gate.consume(window(30))["state"], "unknown")

    def test_biting_burping_or_keywords_are_not_eating_proof(self):
        gate = EatingCandidateGate()
        for i in range(3):
            result = gate.consume(window(i * 10, scores={"Biting": 0.99, "Burping, eructation": 0.99}))
        self.assertEqual(result["state"], "unknown")

    def test_repeated_or_overlapping_windows_cannot_accumulate(self):
        gate = EatingCandidateGate()
        gate.consume(window(0))
        self.assertEqual(gate.consume(window(0))["reason"], "overlapping_or_out_of_order_window")
        self.assertEqual(gate.consume(window(5))["reason"], "overlapping_or_out_of_order_window")

    def test_gap_breaks_sustained_evidence(self):
        gate = EatingCandidateGate()
        gate.consume(window(0))
        gate.consume(window(10))
        self.assertEqual(gate.consume(window(60))["state"], "unknown")

    def test_silence_resets_streak(self):
        gate = EatingCandidateGate()
        gate.consume(window(0))
        gate.consume(window(10, scores={}))
        self.assertEqual(gate.consume(window(20))["state"], "unknown")

    def test_cooldown_avoids_repeated_actions(self):
        gate = EatingCandidateGate()
        for i in range(3):
            result = gate.consume(window(i * 10))
        self.assertEqual(result["state"], "eating_candidate")
        self.assertEqual(gate.consume(window(30))["reason"], "cooldown")

    def test_invalid_scores_and_durations_abstain(self):
        for scores in [{"Chewing, mastication": float("nan")}, {"Chewing, mastication": 1.1}]:
            self.assertEqual(EatingCandidateGate().consume(window(0, scores=scores))["reason"], "invalid_model_scores")
        self.assertEqual(EatingCandidateGate().consume(AcousticWindow(0, 0, {}))["reason"], "invalid_window_duration")

    def test_measured_silence_cannot_trigger_despite_classifier_scores(self):
        gate = EatingCandidateGate()
        for i in range(3):
            self.assertEqual(gate.consume(window(i * 10, audio_rms=0.0))["reason"], "near_silence")


if __name__ == "__main__":
    unittest.main()
