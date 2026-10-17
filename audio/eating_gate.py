"""Conservative acoustic trigger candidate, not an intake or identity classifier.

Thresholds are engineering defaults awaiting device-specific calibration.
Semantic utterances are handled by the separate context decision layer.
"""

from dataclasses import dataclass, field
import math
from typing import Dict, List, Optional


@dataclass
class AcousticWindow:
    start_sec: float
    end_sec: float
    scores: Dict[str, float]
    source_context: str = "unknown"
    paused: bool = False
    audio_rms: Optional[float] = None


@dataclass
class EatingCandidateGate:
    chewing_threshold: float = 0.35
    speech_threshold: float = 0.60
    music_threshold: float = 0.30
    required_windows: int = 3
    min_window_sec: float = 8.0
    max_window_sec: float = 12.0
    max_gap_sec: float = 2.5
    cooldown_sec: float = 180.0
    min_rms: float = 0.0001
    _streak: List[AcousticWindow] = field(default_factory=list)
    _last_seen_end: Optional[float] = None
    _last_trigger_end: Optional[float] = None

    def _unknown(self, reason):
        self._streak.clear()
        return self._result("unknown", reason, "defer")

    @staticmethod
    def _result(state, reason, action):
        return {"state": state, "reason": reason, "action_recommendation": action,
                "speaker": "unknown", "subject": "unknown", "requires_confirmation": True,
                "meal_confirmed": False, "calories": None,
                "camera_started": False, "reminder_sent": False}

    def consume(self, window):
        times = (window.start_sec, window.end_sec)
        if not all(math.isfinite(t) for t in times) or times[0] < 0:
            return self._unknown("invalid_window")
        duration = window.end_sec - window.start_sec
        if duration < self.min_window_sec or duration > self.max_window_sec:
            return self._unknown("invalid_window_duration")
        if self._last_seen_end is not None and window.start_sec < self._last_seen_end - 0.001:
            return self._unknown("overlapping_or_out_of_order_window")
        gap = None if self._last_seen_end is None else window.start_sec - self._last_seen_end
        self._last_seen_end = window.end_sec
        if gap is not None and gap > self.max_gap_sec:
            self._streak.clear()
        if window.paused:
            return self._unknown("user_paused")
        if window.source_context in {"media", "other_person", "tv", "test_media"}:
            return self._unknown("excluded_source")
        if window.source_context not in {"unknown", "live"}:
            return self._unknown("invalid_source_context")
        if window.audio_rms is not None:
            if not math.isfinite(window.audio_rms) or window.audio_rms < 0:
                return self._unknown("invalid_audio_rms")
            if window.audio_rms < self.min_rms:
                return self._unknown("near_silence")
        if not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1
                   for v in window.scores.values()):
            return self._unknown("invalid_model_scores")
        if self._last_trigger_end is not None and window.end_sec - self._last_trigger_end < self.cooldown_sec:
            return self._unknown("cooldown")
        if window.scores.get("Music", 0) >= self.music_threshold:
            return self._unknown("music_confound")
        if window.scores.get("Speech", 0) >= self.speech_threshold:
            return self._unknown("speech_confound")
        if window.scores.get("Chewing, mastication", 0) < self.chewing_threshold:
            return self._unknown("insufficient_acoustic_evidence")
        self._streak.append(window)
        if len(self._streak) < self.required_windows:
            return self._result("unknown", "awaiting_sustained_evidence", "defer")
        start = self._streak[0].start_sec
        self._streak.clear()
        self._last_trigger_end = window.end_sec
        result = self._result("eating_candidate", "sustained_chewing_like_audio", "capture_window")
        result.update({"evidence_start_sec": start, "evidence_end_sec": window.end_sec,
                       "source_context": window.source_context,
                       "scope": "audible_environment_only", "thresholds_calibrated": False})
        return result
