#!/usr/bin/env python3
"""Bounded loopback Decider Q4 service. Never connects to the product backend."""

import argparse
from collections import deque
from dataclasses import dataclass, field
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import platform
import queue
import re
import socket
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
LOCK_FILE = Path(__file__).with_name("decider-model.lock.json")
MODEL_NAME = "decider-0.8b-q4"
N_CTX = 2048
MAX_REQUEST_BYTES = 65536
MAX_STATE_CHARS = 12000
MAX_QUESTIONS = 4


class APIError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_assets(source, directory):
    lock = json.loads(LOCK_FILE.read_text())
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != lock["source"]["commit"]:
        raise ValueError("Decider source differs from the pinned commit; preserve it and use another checkout")
    if subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--", "decider"], check=False).returncode:
        raise ValueError("Pinned Decider source has local changes; preserve them before starting this service")
    for name, expected in lock["model"]["files"].items():
        path = directory / name
        if (not path.is_file() or path.stat().st_size != expected["bytes"]
                or sha256_file(path) != expected["sha256"]):
            raise ValueError(f"Missing or mismatched pinned model asset: {name}; run setup-decider.py")
    return lock


def validate_payload(payload):
    if not isinstance(payload, dict) or set(payload) - {"state", "questions"}:
        raise APIError(400, "invalid_request", "Expected only state and questions")
    state = payload.get("state")
    if not isinstance(state, (str, dict)) or not state:
        raise APIError(400, "invalid_state", "state must be a non-empty string or object")
    stack = [(state, 0)]
    while stack:
        value, depth = stack.pop()
        if depth > 8:
            raise APIError(400, "invalid_state", "state nesting exceeds 8 levels")
        if isinstance(value, dict):
            if len(value) > 64 or any(not isinstance(k, str) or len(k) > 120 for k in value):
                raise APIError(400, "invalid_state", "state object is too large")
            stack.extend((v, depth + 1) for v in value.values())
        elif isinstance(value, list):
            if len(value) > 64:
                raise APIError(400, "invalid_state", "state array exceeds 64 elements")
            stack.extend((v, depth + 1) for v in value)
        elif isinstance(value, float) and not math.isfinite(value):
            raise APIError(400, "invalid_state", "state contains non-finite values")
        elif not isinstance(value, (str, int, float, bool, type(None))):
            raise APIError(400, "invalid_state", "state contains an unsupported value")
    context = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(context) > MAX_STATE_CHARS:
        raise APIError(413, "state_too_large", "state exceeds 12000 characters")
    questions = payload.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= MAX_QUESTIONS:
        raise APIError(400, "invalid_questions", "Expected 1..4 questions")
    seen = set()
    for question in questions:
        if not isinstance(question, dict) or set(question) != {"id", "type", "question", "options"}:
            raise APIError(400, "invalid_question", "Each question requires id, type, question and options")
        identifier = question["id"]
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", identifier) or identifier in seen:
            raise APIError(400, "invalid_question_id", "Question ids must be unique, 1..80 safe characters")
        seen.add(identifier)
        if question["type"] != "choice":
            raise APIError(400, "unsupported_question_type", "Only choice questions are supported")
        text, options = question["question"], question["options"]
        if not isinstance(text, str) or not text.strip() or len(text) > 1000:
            raise APIError(400, "invalid_question", "Question text must contain 1..1000 characters")
        if not isinstance(options, dict) or not 2 <= len(options) <= 10:
            raise APIError(400, "invalid_options", "Expected 2..10 named options")
        if any(not isinstance(k, str) or not k.strip() or len(k) > 100 for k in options):
            raise APIError(400, "invalid_options", "Option ids must contain 1..100 characters")
        if any(not isinstance(v, str) or not v.strip() or len(v) > 1000 for v in options.values()):
            raise APIError(400, "invalid_options", "Option descriptions must contain 1..1000 characters")
    return context, questions


class DeciderEngine:
    def __init__(self, source, model_directory, backend="cpu", threads=2):
        self.lock = validate_assets(source, model_directory)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
        sys.path.insert(0, str(source))
        import llama_cpp
        from decider.infer import Decider

        if backend == "metal" and (platform.system() != "Darwin" or not llama_cpp.llama_supports_gpu_offload()):
            raise ValueError("Metal requested but the native build/platform does not support GPU offload")
        self.native_messages = deque(maxlen=256)

        @llama_cpp.llama_log_callback
        def native_log(level, text, data):
            if text:
                self.native_messages.append(text.decode("utf-8", errors="replace")[:2048])

        self.native_log_callback = native_log  # Keep the C callback alive.
        llama_cpp.llama_log_set(native_log, None)
        started = time.perf_counter()
        self.model = Decider(str(model_directory / self.lock["model"]["filename"]), device="cpu",
                             gguf_options={"n_ctx": N_CTX, "n_threads": threads, "n_seq_max": 1,
                                           "n_gpu_layers": -1 if backend == "metal" else 0,
                                           "verbose": True})
        self.model_lock = threading.Lock()
        native_log_text = "".join(self.native_messages)
        offloads = re.findall(r"offloaded (\d+)/(\d+) layers to GPU", native_log_text)
        offloaded = int(offloads[-1][0]) if offloads else 0
        if backend == "metal" and (not offloads or offloaded == 0 or "Metal" not in native_log_text):
            raise ValueError("Metal was requested but actual layer offload could not be verified; use CPU")
        if backend == "cpu" and offloaded:
            raise ValueError("CPU-only configuration unexpectedly offloaded model layers")
        self.metadata = {"status": "ready", "model": MODEL_NAME,
                         "sha256": self.lock["model"]["files"][self.lock["model"]["filename"]]["sha256"],
                         "model_bytes": self.lock["model"]["files"][self.lock["model"]["filename"]]["bytes"],
                         "source_commit": self.lock["source"]["commit"],
                         "model_revision": self.lock["model"]["revision"],
                         "actual_backend": backend, "runtime": "llama.cpp",
                         "llama_cpp_python": llama_cpp.__version__, "gpu_layers_offloaded": offloaded,
                         "n_ctx": N_CTX, "n_seq_max": 1, "threads": threads,
                         "model_load_seconds": round(time.perf_counter() - started, 4),
                         "domain_calibrated": False}

    def info(self):
        return dict(self.metadata)

    def evaluate(self, payload):
        context, questions = validate_payload(payload)
        started = time.perf_counter()
        answers, input_tokens = [], 0
        with self.model_lock:
            context_tokens = len(self.model.m.tok.encode("Context:\n" + context, add_special_tokens=False))
            if context_tokens > N_CTX:
                raise APIError(422, "context_too_long", "State plus question/options must fit 2048 tokens; nothing is truncated")
            prepared = []
            for question in questions:
                native_question = {"question": question["question"], "options": list(question["options"].values())}
                _, items = self.model._decide_items([(context, [native_question])], max_ctx_tokens=N_CTX)
                tokens = len(items[0]["ids"])
                if tokens > N_CTX:
                    raise APIError(422, "context_too_long", "State plus question/options must fit 2048 tokens; nothing is truncated")
                prepared.append((question, native_question, tokens))
            # Score each question independently; one mutable native context is
            # protected by this lock, with n_seq_max=1 for reproducibility.
            for question, native_question, tokens in prepared:
                result = self.model.decide(context, [native_question], max_ctx_tokens=N_CTX)[0]
                values = result["probs_list"]
                if (len(values) != len(question["options"])
                        or any(not math.isfinite(p) or not 0 <= p <= 1 for p in values)
                        or abs(sum(values) - 1) > 0.0001):
                    raise RuntimeError("Native model returned invalid option probabilities")
                keys = list(question["options"])
                ranking = sorted(range(len(values)), key=values.__getitem__, reverse=True)
                answers.append({"id": question["id"], "type": "choice", "value": keys[ranking[0]],
                                "top_probability": values[ranking[0]],
                                "margin": values[ranking[0]] - values[ranking[1]],
                                "distribution": dict(zip(keys, values))})
                input_tokens += tokens
        return {"model": MODEL_NAME, "backend": self.metadata["actual_backend"],
                "results": [{"answers": answers}],
                "usage": {"wall_ms": round((time.perf_counter() - started) * 1000, 3),
                          "input_tokens": input_tokens, "output_tokens": 0}, "domainCalibrated": False}


@dataclass
class Job:
    payload: dict
    deadline: float
    enqueued: float = field(default_factory=time.perf_counter)
    done: threading.Event = field(default_factory=threading.Event)
    cancelled: threading.Event = field(default_factory=threading.Event)
    result: dict = None
    error: Exception = None


class InferenceQueue:
    def __init__(self, engine, max_pending=2, timeout=12):
        if not 1 <= max_pending <= 8 or not 0.05 <= timeout <= 60:
            raise ValueError("Invalid bounded queue configuration")
        self.engine, self.timeout = engine, timeout
        self.jobs = queue.Queue(maxsize=max_pending)
        self.active, self.stopping = False, False
        self.worker = threading.Thread(target=self._run, name="DeciderSingleModel", daemon=True)
        self.worker.start()

    def _run(self):
        while True:
            job = self.jobs.get()
            try:
                if job is None:
                    return
                if job.cancelled.is_set() or time.perf_counter() >= job.deadline:
                    job.error = APIError(504, "request_timeout", "Queued request expired without inference")
                    job.done.set()
                    continue
                self.active = True
                started = time.perf_counter()
                try:
                    job.result = self.engine.evaluate(job.payload)
                    job.result.setdefault("usage", {})["queue_ms"] = round((started - job.enqueued) * 1000, 3)
                except Exception as error:
                    job.error = error
                finally:
                    self.active = False
                    job.done.set()
            finally:
                self.jobs.task_done()

    def submit(self, payload):
        if self.stopping:
            raise APIError(503, "service_stopping", "Service is stopping")
        job = Job(payload, time.perf_counter() + self.timeout)
        try:
            self.jobs.put_nowait(job)
        except queue.Full:
            raise APIError(503, "queue_full", "The single model worker and pending queue are busy") from None
        if not job.done.wait(max(0, job.deadline - time.perf_counter())):
            job.cancelled.set()
            raise APIError(504, "request_timeout", "Inference deadline elapsed; queued work is not retried")
        if job.error:
            raise job.error
        return job.result

    def info(self):
        return {**self.engine.info(), "inference": {"active": self.active, "pending": self.jobs.qsize(),
                "max_pending": self.jobs.maxsize, "request_timeout_seconds": self.timeout}}

    def close(self):
        if self.stopping:
            return
        self.stopping = True
        while True:
            try:
                job = self.jobs.get_nowait()
            except queue.Empty:
                break
            job.error = APIError(503, "service_stopping", "Service is stopping")
            job.cancelled.set(); job.done.set(); self.jobs.task_done()
        self.jobs.put_nowait(None)
        self.worker.join(timeout=5)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON keys are not supported")
        value[key] = item
    return value


def make_handler(inference):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *args):
            pass  # Never log transcripts or request bodies.

        def send_json(self, status, value):
            data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                if status in (503, 504):
                    self.send_header("Retry-After", "1")
                self.end_headers(); self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            self.close_connection = True

        def do_GET(self):
            if self.path != "/health":
                self.send_json(404, {"error": "not_found"}); return
            self.send_json(200, {**inference.info(), "limits": {
                "request_bytes": MAX_REQUEST_BYTES, "state_characters": MAX_STATE_CHARS,
                "questions": MAX_QUESTIONS, "options_per_question": [2, 10], "n_ctx": N_CTX}})

        def do_POST(self):
            if self.path != "/api/evaluate":
                self.send_json(404, {"error": "not_found"}); return
            try:
                origin = self.headers.get("Origin")
                allowed_origins = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
                if origin and origin not in allowed_origins:
                    raise APIError(403, "origin_not_allowed", "Only local service callers are accepted")
                if self.headers.get("Transfer-Encoding"):
                    raise APIError(400, "unsupported_transfer_encoding", "Use a bounded Content-Length request")
                if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                    raise APIError(415, "json_required", "Content-Type must be application/json")
                lengths = self.headers.get_all("Content-Length", [])
                if not lengths:
                    raise APIError(411, "length_required", "Content-Length is required")
                if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,9}", lengths[0]):
                    raise APIError(400, "invalid_length", "Invalid Content-Length")
                length = int(lengths[0])
                if not 0 < length <= MAX_REQUEST_BYTES:
                    raise APIError(413, "request_too_large", "Request body must contain 1..65536 bytes")
                data = self.rfile.read(length)
                if len(data) != length:
                    raise APIError(400, "incomplete_request", "Request body is incomplete")
                try:
                    payload = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                                         parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite JSON")))
                except (ValueError, UnicodeError, RecursionError):
                    raise APIError(400, "invalid_json", "Expected finite UTF-8 JSON without duplicate keys") from None
                validate_payload(payload)  # Reject bad inputs before using the queue.
                self.send_json(200, inference.submit(payload))
            except APIError as error:
                self.send_json(error.status, {"error": error.code, "message": str(error)})
            except socket.timeout:
                self.send_json(408, {"error": "body_timeout"})
            except Exception as error:
                print(json.dumps({"event": "inference_error", "type": type(error).__name__}), file=sys.stderr, flush=True)
                self.send_json(500, {"error": "inference_failed", "message": "Model inference failed; no action was performed"})
    return Handler


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8
    allow_reuse_address = True

    def __init__(self, address, handler, max_connections=8):
        self.connections = threading.BoundedSemaphore(max_connections)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            try:
                request.settimeout(1)
                body = b'{"error":"server_busy"}\n'
                request.sendall((f"HTTP/1.0 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connections.release(); raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8150)
    parser.add_argument("--backend", choices=("cpu", "metal"), default="cpu")
    parser.add_argument("--threads", type=int, choices=range(1, 9), default=2)
    parser.add_argument("--max-pending", type=int, choices=range(1, 9), default=2)
    parser.add_argument("--request-timeout", type=float, default=12)
    parser.add_argument("--source", type=Path, default=ROOT / ".tools/decider")
    parser.add_argument("--model-directory", type=Path, default=ROOT / ".tools/decider-08b-gguf")
    parser.add_argument("--lock-file", type=Path, default=ROOT / ".data/decider-model.lock")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535 or not 0.05 <= args.request_timeout <= 60:
        parser.error("Invalid port or request timeout")
    # One service model instance per workspace; never resets or kills another process.
    import fcntl
    args.lock_file.parent.mkdir(parents=True, exist_ok=True)
    with args.lock_file.open("a+") as process_lock:
        try:
            fcntl.flock(process_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("A Decider service already holds the model lock")
        process_lock.seek(0); process_lock.truncate()
        process_lock.write(json.dumps({"pid": os.getpid(), "backend": args.backend})); process_lock.flush()
        engine = DeciderEngine(args.source.resolve(), args.model_directory.resolve(), args.backend, args.threads)
        warmup = engine.evaluate({"state": "Synthetic service warmup: ready to eat now.", "questions": [
            {"id": "warmup", "type": "choice", "question": "What happens next?",
             "options": {"eat": "Eat food now.", "other": "Do something unrelated."}}]})
        inference = InferenceQueue(engine, args.max_pending, args.request_timeout)
        server = None
        try:
            server = BoundedHTTPServer(("127.0.0.1", args.port), make_handler(inference))
            print(json.dumps({"event": "ready", "host": "127.0.0.1", "port": server.server_port,
                              "warmup_ms": warmup["usage"]["wall_ms"], **inference.info()}), flush=True)
            server.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            pass
        finally:
            if server:
                server.server_close()
            inference.close()


if __name__ == "__main__":
    main()
