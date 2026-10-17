#!/usr/bin/env python3
"""File-only Silero VAD -> SenseVoice. Audio tagging uses a separate raw stream.

VAD only verifies the presence of speech. It does not identify the speaker or
distinguish real speech from TV/replayed speech.
"""

import argparse
import json
from pathlib import Path
import time

from audio.fetch_models import DEFAULT_DIRECTORY, LOCK, matches, digest_file
from audio.local_audio import SenseVoiceEngine, peak_rss_bytes


def transcribe_speech_file(path, model_directory=DEFAULT_DIRECTORY, source_context="unknown",
                           max_duration_sec=3600):
    import numpy as np
    import sherpa_onnx
    import soundfile as sf
    path = Path(path).resolve()
    lock = json.loads(LOCK.read_text())
    vad_asset = next(a for a in lock["single_files"] if a["id"] == "silero_vad")
    vad_path = Path(model_directory) / vad_asset["name"]
    if not matches(vad_path, vad_asset):
        raise FileNotFoundError("Fetch/verify the VAD model using python -m audio.fetch_models --model silero_vad")
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(vad_path)
    config.silero_vad.threshold = 0.5
    config.silero_vad.min_silence_duration = 0.25
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = 20
    config.sample_rate = 16000
    config.num_threads = 1
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)
    recognizer = None
    report = {"schema_version": 1, "audio_path": str(path), "audio_sha256": digest_file(path),
              "source_context": source_context,
              "speaker": "unknown", "subject": "unknown", "identity_verified": False,
              "speech_vad": {"model": "silero_vad", "sha256": vad_asset["sha256"], "threshold": 0.5},
              "microphone_started": False, "camera_started": False, "meal_created": False,
              "segments": []}
    started = time.perf_counter()
    with sf.SoundFile(str(path)) as source:
        if source.samplerate != 16000:
            raise ValueError("Speech pipeline requires 16 kHz input; resample explicitly before use")
        limit = min(len(source), int(max_duration_sec * 16000))
        report["truncated"] = len(source) > limit
        report["processed_duration_sec"] = limit / 16000

        def drain():
            nonlocal recognizer
            while not vad.empty():
                front = vad.front
                vad_start = front.start
                vad_end = min(limit, front.start + len(front.samples))
                vad.pop()
                # VAD boundaries can cut initial/final phonemes. Read bounded
                # context via a separate descriptor so the streaming cursor is
                # untouched. Live capture must retain this lookback/tail buffer.
                offset = max(0, vad_start - int(0.3 * 16000))
                end = min(limit, vad_end + int(0.5 * 16000))
                with sf.SoundFile(str(path)) as segment_source:
                    segment_source.seek(offset)
                    block = segment_source.read(max(0, end - offset), dtype="float32", always_2d=True)
                samples = np.ascontiguousarray(block.mean(axis=1), dtype=np.float32)
                if not len(samples):
                    continue
                rms = float(np.sqrt(np.mean(samples ** 2)))
                if rms < 0.0001:
                    continue
                if recognizer is None:
                    recognizer = SenseVoiceEngine(model_directory)
                result = recognizer.infer(samples, 16000, offset / 16000)
                result.update({"window_start_sec": offset / 16000,
                               "window_end_sec": (offset + len(samples)) / 16000,
                               "raw_vad_start_sec": vad_start / 16000,
                               "raw_vad_end_sec": vad_end / 16000,
                               "speech_context_padding_sec": {"before": 0.3, "after": 0.5},
                               "audio_rms": rms, "speech_vad_verified": True,
                               "source_context": source_context, "identity_verified": False,
                               "eligible_for_semantic_analysis": source_context not in {"media", "other_person", "test_media"},
                               "meal_confirmed": False})
                report["segments"].append(result)

        frames_read = 0
        while frames_read < limit:
            block = source.read(min(config.silero_vad.window_size, limit - frames_read), dtype="float32", always_2d=True)
            frames_read += len(block)
            mono = np.ascontiguousarray(block.mean(axis=1), dtype=np.float32)
            if not np.isfinite(mono).all():
                raise ValueError("Non-finite audio samples")
            if len(mono) < config.silero_vad.window_size:
                mono = np.pad(mono, (0, config.silero_vad.window_size - len(mono)))
            vad.accept_waveform(mono)
            drain()
        vad.flush()
        drain()
    report["elapsed_seconds_including_model_load"] = time.perf_counter() - started
    report["process_peak_rss_bytes"] = peak_rss_bytes()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", nargs="+", type=Path)
    parser.add_argument("--model-directory", type=Path, default=DEFAULT_DIRECTORY)
    parser.add_argument("--source-context", choices=("unknown", "live", "media", "other_person", "test_media"), default="unknown")
    parser.add_argument("--max-duration-sec", type=float, default=3600)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 0 < args.max_duration_sec <= 86400:
        parser.error("max-duration-sec must be in (0,86400]")
    results = [transcribe_speech_file(p, args.model_directory, args.source_context, args.max_duration_sec) for p in args.audio]
    document = json.dumps({"schema_version": 1, "results": results}, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(document)
        print(json.dumps({"output": str(args.output.resolve()), "files": len(results)}))
    else:
        print(document, end="")


if __name__ == "__main__":
    main()
