#!/usr/bin/env python3
"""Research-only raw Decima-small Chinese meal-context comparison.

No rule override, backend submission, microphone, ADB or production integration.
Requires pre-downloaded model/source and the decision-venv supplied by this task.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]

QUESTION = "根据完整上下文，用户本人当前的用餐准备状态是什么？计划和邀请不是实际摄入，背景媒体不是本人行动。"
OPTIONS = {
    "start_soon": "用户本人明确表示现在或马上准备吃东西，适合短时拍摄确认。",
    "invited": "有人邀请吃东西，但尚未明确用户本人接受或开始。",
    "eating_now": "上下文明确表示用户本人当前正在吃东西。",
    "finished": "谈论已经吃完或过去的进食，当前不应开始拍摄。",
    "declined": "用户明确拒绝、取消或停止吃东西。",
    "unrelated": "只是在谈论食物、别人、未来安排、媒体或其他事情。",
    "uncertain": "证据不足，无法确定用户本人现在是否准备吃东西。",
}

SHORT_QUESTION = "What is the speaker's meal intent right now?"
SHORT_OPTIONS = {
    "start_soon": "Plans to eat now or very soon.",
    "invited": "Invited to eat, but has not accepted.",
    "eating_now": "Is eating right now.",
    "finished": "Has already finished eating.",
    "declined": "Refuses or cancels eating food.",
    "unrelated": "Unrelated to eating now, or future or hypothetical.",
    "uncertain": "Insufficient evidence to determine meal intent.",
}

CASES = [
    {"id": "self_immediate_plan", "text": "我要去吃饭了", "expected": "start_soon"},
    {"id": "invitation", "text": "你要不要吃？", "expected": "invited"},
    {"id": "accepts_invitation", "text": "好啊，走吧", "recent": ["你要不要一起吃午饭？"], "expected": "start_soon"},
    {"id": "self_current_eating", "text": "我正在吃午饭", "expected": "eating_now"},
    {"id": "future_plan", "text": "明天我们去吃火锅吧", "expected": "unrelated"},
    {"id": "already_finished", "text": "我刚吃完饭", "expected": "finished"},
    {"id": "unknown_speaker", "text": "我要去吃饭了", "speaker": "unknown", "source": "unknown", "expected": "uncertain"},
    {"id": "background_media", "text": "主播说我要去吃饭了", "speaker": "unknown", "source": "media", "expected": "unrelated"},
    {"id": "declines", "text": "我不想吃了", "expected": "declined"},
    {"id": "weather", "text": "今天天气不错", "expected": "unrelated"},
    {"id": "other_person", "text": "我要去吃饭了", "speaker": "other", "expected": "unrelated"},
    {"id": "taking_medicine", "text": "我正在吃药", "expected": "unrelated"},
    {"id": "quoted_example", "text": "比如我要去吃饭了这句话", "expected": "unrelated"},
    {"id": "opening_hours", "text": "开放时间早上9点至下午5点。", "expected": "unrelated"},
    {"id": "asr_opening_meal_homophone", "text": "开饭时间早上9点至下午5点。", "expected": "unrelated"},
    {"id": "meal_ready", "text": "开饭了", "expected": "start_soon"},
    {"id": "third_party_plan", "text": "他马上去吃午饭", "expected": "unrelated"},
    {"id": "cancels_after_invitation", "text": "我不去了，暂时不吃了", "recent": ["要不要一起吃饭？", "好啊"], "expected": "declined"},
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("original", "short"), default="original")
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    source = ROOT / ".tools/decima"
    model = ROOT / ".tools/decima-small-model/onnx/int8"
    sys.path.insert(0, str(source))
    from decima import Decima, Question
    import onnxruntime
    import transformers

    commit = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if commit != "0ab6f2164abb34caa749f31ac643801d1b4b03b7":
        raise ValueError("Decima source differs from the parent-specified review commit")
    hashes = {}
    for path in sorted(model.rglob("*")):
        if path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as data:
                for block in iter(lambda: data.read(1024 * 1024), b""):
                    digest.update(block)
            hashes[str(path.relative_to(model))] = {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}
    started = time.perf_counter()
    engine = Decima(model, threads=2)
    load_seconds = time.perf_counter() - started
    short = args.format == "short"
    question_text = SHORT_QUESTION if short else QUESTION
    options = SHORT_OPTIONS if short else OPTIONS
    question = Question(question_text, list(options.values()), kind="choose", lang="en" if short else "zh")
    keys = list(options)
    results = []
    for case in CASES:
        if short:
            state = {"Message": case["text"], "Previous": case.get("recent", [])}
            previous = "\n".join(case.get("recent", [])) or "(none)"
            state_text = f"Message: {case['text']}\nPrevious: {previous}"
        else:
            state = {"transcript": case["text"], "speaker": case.get("speaker", "self"),
                     "source": case.get("source", "user-conversation"),
                     "recent_utterances": case.get("recent", []), "audio_events": []}
            state_text = json.dumps(state, ensure_ascii=False)
        runs = []
        for _ in range(2):
            outer_started = time.perf_counter()
            answer = engine.decide(state_text, question)
            wall_ms = (time.perf_counter() - outer_started) * 1000
            order = sorted(range(len(keys)), key=lambda i: answer.probs[i], reverse=True)
            runs.append({"prediction": keys[order[0]], "choice_text": answer.top,
                         "top_probability": answer.confidence,
                         "margin": answer.probs[order[0]] - answer.probs[order[1]],
                         "distribution": dict(zip(keys, answer.probs)),
                         "native_latency_ms": answer.latency_ms, "wall_ms": wall_ms,
                         "abstained": answer.abstained})
        results.append({"id": case["id"], "state": state, "state_serialization": state_text,
                        "synthetic_expected_stage": case["expected"], "runs": runs,
                        "raw_top_matches_synthetic_label": runs[0]["prediction"] == case["expected"],
                        "expected_label_requires_omitted_context": short and case["id"] in {"unknown_speaker", "other_person"},
                        "fixture_metadata_not_provided_to_model": {"speaker": case.get("speaker", "self"),
                                                                   "source": case.get("source", "user-conversation")} if short else {},
                        "rule_override_applied": False})
        print(json.dumps({"id": case["id"], "prediction": runs[0]["prediction"],
                          "p": round(runs[0]["top_probability"], 4),
                          "warm_ms": round(runs[1]["wall_ms"], 2)}, ensure_ascii=False), flush=True)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Verify that this result is not caused by silent input/choice truncation.
    _, rendered_question = engine._choice_key(question)
    rendered_choices = engine._choice_texts(question, rendered_question)
    input_audit = {"max_state_tokens": engine.cfg["max_state_tokens"],
                   "max_choice_tokens": engine.cfg["max_choice_tokens"],
                   "choice_fit_config": engine.cfg.get("choice_fit", False),
                   "rendered_choices": [{"key": key, "text": text,
                                         "tokens": len(engine.tok(text)["input_ids"])}
                                        for key, text in zip(keys, rendered_choices)],
                   "max_state_tokens_used": max(len(engine.tok(engine._state(r["state_serialization"], question))["input_ids"])
                                                for r in results)}
    report = {"schema_version": 1, "checked_at_utc": datetime.now(timezone.utc).isoformat(),
              "model": "decima-small / 122M / INT8", "source_commit": commit,
              "model_files": hashes, "model_load_seconds": load_seconds,
              "runtime": {"onnxruntime": onnxruntime.__version__, "transformers": transformers.__version__,
                          "provider": "CPUExecutionProvider", "threads": 2, "python": platform.python_version(),
                          "system": platform.system(), "machine": platform.machine()},
              "question": {"text": question_text, "options": options, "language": question.lang, "kind": "choose"},
              "prompt_variant": args.format,
              "comparison_scope": "same synthetic development set after initial prompt review; not an independent accuracy evaluation",
              "external_filters_not_applied": ["speaker_identity", "media_source"] if short else [],
              "input_audit": input_audit,
              "records": results,
              "summary": {"synthetic_cases": len(results),
                          "raw_top_label_agreement": sum(r["raw_top_matches_synthetic_label"] for r in results),
                          "text_identifiable_cases": sum(not r["expected_label_requires_omitted_context"] for r in results),
                          "text_identifiable_label_agreement": sum(r["raw_top_matches_synthetic_label"] for r in results
                                                                  if not r["expected_label_requires_omitted_context"]),
                          "median_warm_wall_ms": statistics.median(r["runs"][1]["wall_ms"] for r in results),
                          "max_warm_wall_ms": max(r["runs"][1]["wall_ms"] for r in results)},
              "process_peak_rss_bytes": int(rss if sys.platform == "darwin" else rss * 1024),
              "fixture_only": True, "domain_accuracy_validated": False, "domain_confidence_calibrated": False,
              "rule_override_applied": False, "production_backend_modified": False,
              "microphone_started": False, "phone_touched": False,
              "licensing_scope": "research comparison only; author discloses non-commercial training data, not selected as commercial default"}
    output = ROOT / "output/validation" / ("decima-context-short-prompt.json" if short else "decima-context.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(output), **report["summary"]}), flush=True)


if __name__ == "__main__":
    main()
