#!/usr/bin/env python3
"""Export explicit speech segments to backend /api/signals/context JSON.

Never posts automatically. Capture start is required; processing time and file
mtime are not substituted for the real recording timestamp. Identity defaults
to unknown. A model event token has no probability and is not assigned one.
"""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path

from audio.fetch_models import LOCK


def parse_capture_start(value):
    if not isinstance(value, str):
        raise ValueError("Actual captureStartedAt is required; do not substitute processing time")
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError("captureStartedAt must contain a real timezone offset")
    return timestamp


def chunk_recording_start(capture_started_at, receipt, expected_audio_sha256):
    """Map a continuous AudioRecord session's frame offset to this WAV's start."""
    if (receipt.get("schema_version") not in {1, 2} or receipt.get("sample_rate") != 16000
            or receipt.get("channels") != 1 or receipt.get("encoding") != "pcm_s16le"):
        raise ValueError("Receipt must describe mono 16 kHz PCM16 WAV")
    offset, frames = receipt.get("frame_offset"), receipt.get("frames")
    if type(offset) is not int or offset < 0 or type(frames) is not int or frames <= 0:
        raise ValueError("Invalid continuous PCM frame range")
    if receipt.get("sha256") != expected_audio_sha256:
        raise ValueError("Receipt and analyzed WAV hashes differ")
    recorded_start = receipt.get("capture_started_at")
    if receipt.get("schema_version") == 2 and recorded_start is None:
        raise ValueError("Schema 2 receipts must persist capture_started_at")
    if recorded_start is not None and capture_started_at is not None:
        if parse_capture_start(recorded_start) != parse_capture_start(capture_started_at):
            raise ValueError("Receipt and supplied recording start differ")
    started = parse_capture_start(recorded_start or capture_started_at) + timedelta(seconds=offset / 16000)
    if receipt.get("chunk_started_at") is not None and parse_capture_start(receipt["chunk_started_at"]) != started:
        raise ValueError("Persisted chunk start differs from the PCM frame offset")
    return started.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def to_context_signals(report, capture_started_at, tagging_reports=None,
                       speaker="unknown", source_context="unknown", dry_run=True,
                       speaker_evidence=None):
    if speaker not in {"unknown", "other", "self"}:
        raise ValueError("Invalid speaker attribution")
    if source_context not in {"unknown", "media", "user-conversation", "test-fixture"}:
        raise ValueError("Invalid source context")
    if speaker == "self" and not speaker_evidence:
        raise ValueError("Explicit independent speaker evidence is required to assign self")
    started = parse_capture_start(capture_started_at)
    audio_hash = report.get("audio_sha256")
    if not isinstance(audio_hash, str) or len(audio_hash) != 64:
        raise ValueError("Original audio SHA-256 is required")
    # Public model fixtures can never become live user evidence by CLI defaults.
    lock = json.loads(LOCK.read_text())
    public_hashes = {info["sha256"] for asset in lock["assets"]
                     for name, info in asset["files"].items() if name.startswith("test_wavs/")}
    if audio_hash in public_hashes:
        source_context = "test-fixture"
        speaker = "unknown"
    if report.get("source_context") in {"media", "test_media"}:
        source_context = "media" if report["source_context"] == "media" else "test-fixture"
    if report.get("source_context") == "other_person":
        speaker = "other"
    matching_tags = [r for r in (tagging_reports or []) if r.get("audio_sha256") == audio_hash]
    signals, recent = [], []
    for segment in report.get("segments", []):
        text = segment.get("text", "").strip()
        start, end = segment.get("window_start_sec"), segment.get("window_end_sec")
        if not segment.get("speech_vad_verified") or not text:
            continue
        if not all(isinstance(t, (int, float)) and math.isfinite(t) for t in (start, end)) or not 0 <= start < end:
            raise ValueError("Invalid ASR segment time range")
        if segment.get("audio_rms", 0) < 0.0001 or segment.get("event_tag") != "<|Speech|>":
            continue
        observed = started + timedelta(seconds=end)
        events = {}
        for tag_report in matching_tags:
            for window in tag_report.get("windows", []):
                if window["window_start_sec"] >= end or window["window_end_sec"] <= start:
                    continue
                actual = window.get("scores") or window.get("relevant_scores", {})
                for label, score in actual.items():
                    if isinstance(score, (int, float)) and math.isfinite(score) and 0 <= score <= 1:
                        events[label] = max(events.get(label, 0), score)
        identifier = hashlib.sha256(f"{audio_hash}|{started.isoformat()}|{start}|{end}|{text}".encode()).hexdigest()
        segment_speaker, segment_context = speaker, source_context
        if segment.get("source_context") in {"media", "test_media"}:
            segment_context = "media" if segment["source_context"] == "media" else "test-fixture"
        if segment.get("source_context") == "other_person":
            segment_speaker = "other"
        signal = {"signalId": "audio-" + identifier[:32], "text": text[:3000],
                  "speaker": segment_speaker, "sourceContext": segment_context,
                  "observedAt": observed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "recentUtterances": recent[-8:],
                  "audioEvents": [{"label": label, "score": score} for label, score in
                                  sorted(events.items(), key=lambda item: item[1], reverse=True)[:10]],
                  "dryRun": bool(dry_run),
                  "asrEvidence": {"audioSha256": audio_hash,
                                  "captureStartedAt": started.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                                  "windowStartSec": start, "windowEndSec": end,
                                  "speechVadVerified": True,
                                  "languageTag": segment.get("language_tag", ""),
                                  "emotionTag": segment.get("emotion_tag", ""),
                                  "eventTag": segment.get("event_tag", ""),
                                  "speakerEvidence": speaker_evidence,
                                  "audioEventScoresAreCalibrated": False}}
        signals.append(signal)
        recent.append(text[:500])
    return signals


def chunk_to_context_signals(report, receipt, tagging_reports=None, capture_started_at=None,
                             speaker="unknown", source_context="unknown", dry_run=True,
                             speaker_evidence=None):
    capture_start = chunk_recording_start(capture_started_at, receipt, report["audio_sha256"])
    if receipt.get("time_source") == "synthetic_fixture":
        source_context, speaker = "test-fixture", "unknown"
    return to_context_signals(report, capture_start, tagging_reports, speaker, source_context,
                              dry_run, speaker_evidence)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="audio.speech_pipeline JSON output")
    parser.add_argument("--capture-started-at", help="Actual WAV/session start ISO8601 with timezone; omit only with schema 2 receipt")
    parser.add_argument("--tagging-report", type=Path)
    parser.add_argument("--chunk-receipt", type=Path, help="Completed continuous-WAV receipt; capture-started-at is then the session start")
    parser.add_argument("--speaker", choices=("unknown", "self", "other"), default="unknown")
    parser.add_argument("--speaker-evidence", help="Independent/manual attribution provenance, required for self")
    parser.add_argument("--source-context", choices=("unknown", "user-conversation", "media", "test-fixture"), default="unknown")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    reports = json.loads(args.report.read_text())["results"]
    if len(reports) != 1:
        parser.error("Export one WAV/report at a time to prevent mismatched capture start timestamps")
    tagging = [] if not args.tagging_report else json.loads(args.tagging_report.read_text())["results"]
    if args.chunk_receipt:
        signals = chunk_to_context_signals(reports[0], json.loads(args.chunk_receipt.read_text()), tagging,
                                           args.capture_started_at, args.speaker, args.source_context,
                                           True, args.speaker_evidence)
    else:
        signals = to_context_signals(reports[0], args.capture_started_at, tagging, args.speaker,
                                     args.source_context, True, args.speaker_evidence)
    document = json.dumps({"schema_version": 1, "endpoint": "/api/signals/context",
                           "posted": False, "signals": signals}, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(document)
        print(json.dumps({"output": str(args.output.resolve()), "signals": len(signals), "posted": False}))
    else:
        print(document, end="")


if __name__ == "__main__":
    main()
