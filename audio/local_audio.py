#!/usr/bin/env python3
"""Offline file-only SenseVoice and sound-event inference with bounded windows.

No microphone access, network call, camera activation or meal creation occurs here.
Use `python -m audio.local_audio --help` from the repository root.
"""

import argparse
import csv
import hashlib
import json
from pathlib import Path
import platform
import resource
import sys
import time

from audio.eating_gate import AcousticWindow, EatingCandidateGate
from audio.fetch_models import DEFAULT_DIRECTORY, LOCK, matches


def peak_rss_bytes():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def asset_info(model_id, model_directory):
    lock = json.loads(LOCK.read_text())
    asset = next(a for a in lock["assets"] if a["id"] == model_id)
    directory = Path(model_directory) / asset["directory"]
    for name in ("model.int8.onnx", "tokens.txt" if model_id == "sensevoice_int8" else "class_labels_indices.csv"):
        path = directory / name
        if not matches(path, asset["files"][name]):
            raise FileNotFoundError(f"Missing or wrong-sized model file: {path}. Run python -m audio.fetch_models first.")
    return asset, directory


class SenseVoiceEngine:
    def __init__(self, model_directory=DEFAULT_DIRECTORY, threads=2):
        import sherpa_onnx
        self.asset, self.directory = asset_info("sensevoice_int8", model_directory)
        self.runtime_version = sherpa_onnx.__version__
        start = time.perf_counter()
        self.model = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(self.directory / "model.int8.onnx"),
            tokens=str(self.directory / "tokens.txt"), num_threads=threads,
            language="", use_itn=True, provider="cpu", debug=False)
        self.load_seconds = time.perf_counter() - start
        self.threads = threads

    def infer(self, samples, sample_rate, start_sec=0.0):
        if len(samples) / sample_rate > 30.001:
            raise ValueError("SenseVoice input must be segmented to at most 30 seconds")
        start = time.perf_counter()
        stream = self.model.create_stream()
        stream.accept_waveform(sample_rate, samples)
        self.model.decode_stream(stream)
        elapsed = time.perf_counter() - start
        result = stream.result
        # This is the native recognizer's JSON, not a reconstructed token string.
        raw = json.loads(str(result))
        return {"text": result.text, "raw_result": raw,
                "language_tag": result.lang, "emotion_tag": result.emotion,
                "event_tag": result.event, "speaker": "unknown", "subject": "unknown",
                "token_timestamps_sec": [round(start_sec + t, 4) for t in result.timestamps],
                "inference_seconds": elapsed}


class AudioTaggingEngine:
    def __init__(self, model_directory=DEFAULT_DIRECTORY, threads=2):
        import sherpa_onnx
        self.asset, self.directory = asset_info("zipformer_audio_tagging_int8", model_directory)
        self.runtime_version = sherpa_onnx.__version__
        labels = list(csv.DictReader((self.directory / "class_labels_indices.csv").open()))
        self.labels = {r["display_name"]: {"index": int(r["index"]), "mid": r["mid"]} for r in labels}
        config = sherpa_onnx.AudioTaggingConfig(
            model=sherpa_onnx.AudioTaggingModelConfig(
                zipformer=sherpa_onnx.OfflineZipformerAudioTaggingModelConfig(
                    model=str(self.directory / "model.int8.onnx")),
                num_threads=threads, debug=False, provider="cpu"),
            labels=str(self.directory / "class_labels_indices.csv"), top_k=len(labels))
        if not config.validate():
            raise ValueError("Invalid audio tagging runtime configuration")
        start = time.perf_counter()
        self.model = sherpa_onnx.AudioTagging(config)
        self.load_seconds = time.perf_counter() - start
        self.threads = threads

    def infer(self, samples, sample_rate, start_sec=0.0):
        import numpy as np
        if len(samples) / sample_rate > 12.001:
            raise ValueError("Acoustic tagging input must be segmented to at most 12 seconds")
        start = time.perf_counter()
        stream = self.model.create_stream()
        stream.accept_waveform(sample_rate, samples)
        events = self.model.compute(stream)
        elapsed = time.perf_counter() - start
        scores = {e.name: float(e.prob) for e in events}
        top = [{"label": e.name, "index": e.index, "score": float(e.prob),
                "mid": self.labels[e.name]["mid"]} for e in events[:5]]
        relevant = {name: scores.get(name, 0) for name in ["Chewing, mastication", "Biting", "Speech", "Music"]}
        return {"top_events": top, "scores": scores, "relevant_scores": relevant,
                "audio_rms": float(np.sqrt(np.mean(samples ** 2))),
                "scores_are_calibrated": False, "speaker": "unknown", "subject": "unknown",
                "inference_seconds": elapsed}


def file_windows(path, window_sec, overlap_sec=0, max_duration_sec=3600):
    """Read short float32 blocks; never load an entire long recording into RAM."""
    import numpy as np
    import soundfile as sf
    with sf.SoundFile(str(path)) as source:
        sample_rate = source.samplerate
        window_frames = int(window_sec * sample_rate)
        overlap_frames = int(overlap_sec * sample_rate)
        step = window_frames - overlap_frames
        limit = min(len(source), int(max_duration_sec * sample_rate))
        frame = 0
        while frame < limit:
            source.seek(frame)
            block = source.read(min(window_frames, limit - frame), dtype="float32", always_2d=True)
            mono = np.ascontiguousarray(block.mean(axis=1), dtype=np.float32)
            if not np.isfinite(mono).all():
                raise ValueError("Audio contains non-finite samples")
            if not len(mono):
                break
            yield mono, sample_rate, frame / sample_rate
            if frame + len(mono) >= limit:
                break
            frame += step


def run_file(engine, path, mode, window_sec, repeat=1, max_duration_sec=3600,
             source_context="unknown", include_all_scores=False):
    import soundfile as sf
    path = Path(path).resolve()
    info = sf.info(str(path))
    # File hash is computed in blocks and preserves provenance without copying audio.
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    gate = EatingCandidateGate()
    summary = {"schema_version": 1, "mode": mode, "model": engine.asset["id"],
               "model_sha256": engine.asset["files"]["model.int8.onnx"]["sha256"],
               "runtime": "sherpa-onnx", "runtime_version": engine.runtime_version,
               "provider": "cpu", "threads": engine.threads,
               "model_load_seconds": engine.load_seconds,
               "audio_path": str(path), "audio_sha256": digest.hexdigest(),
               "audio_duration_sec": info.duration,
               "processed_duration_limit_sec": max_duration_sec,
               "truncated": info.duration > max_duration_sec,
               "source_context": source_context, "speaker": "unknown", "subject": "unknown",
               "host": {"system": platform.system(), "machine": platform.machine(),
                        "python": platform.python_version()}, "windows": []}
    overlap = min(2.0, window_sec / 4) if mode == "sensevoice" else 0
    for samples, sample_rate, start_sec in file_windows(path, window_sec, overlap, max_duration_sec):
        times = []
        output = None
        for _ in range(repeat):
            output = engine.infer(samples, sample_rate, start_sec)
            times.append(output["inference_seconds"])
        end_sec = start_sec + len(samples) / sample_rate
        output.update({"window_start_sec": start_sec, "window_end_sec": end_sec,
                       "source_context": source_context, "inference_runs_seconds": times,
                       "real_time_factor": sum(times) / len(times) / (end_sec - start_sec)})
        if mode == "tagging":
            output["gate"] = gate.consume(AcousticWindow(start_sec, end_sec, output["scores"],
                                                         source_context, audio_rms=output["audio_rms"]))
            if not include_all_scores:
                output.pop("scores")
        summary["windows"].append(output)
    summary["process_peak_rss_bytes"] = peak_rss_bytes()
    summary["memory_scope"] = "whole_process_peak_including_runtime_and_model"
    summary["privacy"] = {"microphone_started": False, "network_used_during_inference": False,
                          "camera_started": False, "meal_created": False}
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("sensevoice", "tagging"))
    parser.add_argument("audio", nargs="+", type=Path)
    parser.add_argument("--model-directory", type=Path, default=DEFAULT_DIRECTORY)
    parser.add_argument("--threads", type=int, choices=range(1, 9), default=2)
    parser.add_argument("--repeat", type=int, choices=range(1, 11), default=1)
    parser.add_argument("--window-sec", type=float)
    parser.add_argument("--max-duration-sec", type=float, default=3600)
    parser.add_argument("--source-context", choices=("unknown", "live", "media", "other_person", "test_media"), default="unknown")
    parser.add_argument("--include-all-scores", action="store_true")
    parser.add_argument("--output", type=Path, help="Save JSON; omitted prints JSON to stdout")
    args = parser.parse_args()
    window = args.window_sec or (30.0 if args.mode == "sensevoice" else 10.0)
    maximum = 30 if args.mode == "sensevoice" else 12
    if not 0 < window <= maximum or not 0 < args.max_duration_sec <= 86400:
        parser.error(f"window-sec must be in (0,{maximum}]; max-duration-sec in (0,86400]")
    engine = (SenseVoiceEngine if args.mode == "sensevoice" else AudioTaggingEngine)(args.model_directory, args.threads)
    results = [run_file(engine, path, args.mode, window, args.repeat, args.max_duration_sec,
                        args.source_context, args.include_all_scores) for path in args.audio]
    document = json.dumps({"schema_version": 1, "results": results}, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(document)
        print(json.dumps({"output": str(args.output.resolve()), "files": len(results)}, ensure_ascii=False))
    else:
        print(document, end="")


if __name__ == "__main__":
    main()
