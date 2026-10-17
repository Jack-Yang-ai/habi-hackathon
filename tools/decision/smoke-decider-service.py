#!/usr/bin/env python3
"""Start an ephemeral loopback Decider process, check its contract, then stop it."""

import argparse
import json
from pathlib import Path
import selectors
import signal
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("cpu", "metal"), default="cpu")
    args = parser.parse_args()
    output_dir = ROOT / "output/validation"
    output_dir.mkdir(parents=True, exist_ok=True)
    log_path = ROOT / f".tools/decider-service-smoke-{args.backend}.log"
    process = None
    with log_path.open("wb") as log:
        try:
            process = subprocess.Popen([str(ROOT / ".tools/decider-venv/bin/python"),
                                        str(Path(__file__).with_name("server_decider.py")),
                                        "--port", "0", "--backend", args.backend],
                                       cwd=ROOT, stdout=subprocess.PIPE, stderr=log, text=True)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 90
            ready = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"Service exited {process.returncode}; see {log_path}")
                if selector.select(timeout=0.25):
                    line = process.stdout.readline()
                    if line:
                        candidate = json.loads(line)
                        if candidate.get("event") == "ready":
                            ready = candidate
                            break
            selector.close()
            if ready is None:
                raise TimeoutError("Service did not become ready within 90 seconds")
            base = f"http://127.0.0.1:{ready['port']}"

            def request(path, payload=None):
                data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
                req = urllib.request.Request(base + path, data=data,
                                             headers={} if data is None else {"Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(req, timeout=20) as response:
                        return response.status, json.loads(response.read())
                except urllib.error.HTTPError as response:
                    return response.code, json.loads(response.read())

            code, health = request("/health")
            assert code == 200 and health["actual_backend"] == args.backend, health
            fixtures = json.loads(Path(__file__).with_name("fixtures.json").read_text())
            payload = {"state": {"transcript": "我要去吃饭了", "speaker": "unknown", "source": "unknown",
                                  "recent_utterances": [], "audio_events": []}, "questions": [
                {"id": "meal_stage", "type": "choice", "question": fixtures["chineseQuestion"],
                 "options": fixtures["chineseOptions"]}]}
            code, evaluation = request("/api/evaluate", payload)
            assert code == 200 and evaluation["model"] == "decider-0.8b-q4", evaluation
            answer = evaluation["results"][0]["answers"][0]
            assert answer["id"] == "meal_stage" and set(answer["distribution"]) == set(fixtures["chineseOptions"])
            too_long = {**payload, "state": "饭" * 6000}
            invalid_code, invalid = request("/api/evaluate", too_long)
            assert invalid_code == 422 and invalid["error"] == "context_too_long", invalid
            target = output_dir / f"decider-service-smoke-{args.backend}.json"
            report = {"fixtureOnly": True, "independentAccuracyBenchmark": False,
                      "temporaryPort": ready["port"], "startup": ready, "health": health,
                      "input": payload, "evaluation": evaluation,
                      "overflowRejected": {"httpStatus": invalid_code, **invalid},
                      "productionBackendModified": False, "microphoneStarted": False}
            target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps({"output": str(target), "actual_backend": health["actual_backend"],
                              "gpu_layers_offloaded": health["gpu_layers_offloaded"],
                              "wall_ms": evaluation["usage"]["wall_ms"],
                              "temporary_service_will_stop": True}), flush=True)
        finally:
            if process is not None and process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=3)


if __name__ == "__main__":
    main()
