"""HTTP/resource guards with synthetic fakes; no model, microphone or App access."""

from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import threading
import time
from types import SimpleNamespace
import unittest

import server_decider as service


def payload():
    return {"state": {"transcript": "我要去吃饭了", "speaker": "unknown", "source": "unknown"},
            "questions": [{"id": "meal_stage", "type": "choice", "question": "What happens next?",
                           "options": {"soon": "Prepare to eat now.", "other": "Other activity."}}]}


class FakeEngine:
    def __init__(self, blocked=False):
        self.blocked = blocked
        self.started, self.release = threading.Event(), threading.Event()
        self.calls = self.active = self.peak_active = 0

    def info(self):
        return {"status": "ready", "model": service.MODEL_NAME, "sha256": "0" * 64,
                "actual_backend": "test-fixture", "n_ctx": 2048}

    def evaluate(self, body):
        self.calls += 1; self.active += 1; self.peak_active = max(self.peak_active, self.active)
        self.started.set()
        try:
            if self.blocked and not self.release.wait(2):
                raise RuntimeError("test release timeout")
            return {"model": service.MODEL_NAME, "results": [{"answers": []}], "usage": {"wall_ms": 1}}
        finally:
            self.active -= 1


class HTTPTest(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.inference = service.InferenceQueue(self.engine)
        self.server = service.BoundedHTTPServer(("127.0.0.1", 0), service.make_handler(self.inference))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.inference.close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            conn.request(method, path, body, headers or {})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_health_and_evaluate_keep_expected_contract(self):
        code, data = self.request("GET", "/health")
        self.assertEqual(code, 200)
        self.assertEqual(data["actual_backend"], "test-fixture")
        self.assertEqual(data["inference"]["max_pending"], 2)
        code, data = self.request("POST", "/api/evaluate", json.dumps(payload()).encode(), {"Content-Type": "application/json"})
        self.assertEqual(code, 200)
        self.assertEqual(data["model"], service.MODEL_NAME)
        self.assertIn("queue_ms", data["usage"])

    def test_bad_inputs_are_rejected_before_inference(self):
        for change in (lambda p: p["questions"][0].update(type="boolean"),
                       lambda p: p["questions"][0].update(options={"only": "One choice"}),
                       lambda p: p.update(state="x" * 12001)):
            body = payload(); change(body)
            code, _ = self.request("POST", "/api/evaluate", json.dumps(body).encode(), {"Content-Type": "application/json"})
            self.assertIn(code, (400, 413))
        self.assertEqual(self.engine.calls, 0)

    def test_duplicate_json_keys_and_nonfinite_values_are_rejected(self):
        for raw in [b'{"state":"a","state":"b","questions":[]}', b'{"state":{"x":NaN},"questions":[]}']:
            self.assertEqual(self.request("POST", "/api/evaluate", raw, {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.engine.calls, 0)

    def test_oversized_body_header_rejected_without_reading_body(self):
        code, data = self.request("POST", "/api/evaluate", b"", {
            "Content-Type": "application/json", "Content-Length": str(service.MAX_REQUEST_BYTES + 1)})
        self.assertEqual(code, 413)
        self.assertEqual(data["error"], "request_too_large")

    def test_cross_origin_and_plain_form_requests_are_rejected(self):
        self.assertEqual(self.request("POST", "/api/evaluate", b"{}", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/api/evaluate", b"{}", {
            "Content-Type": "application/json", "Origin": "https://unrelated.example"})[0], 403)

    def test_connections_are_bounded_even_when_a_client_stops_sending(self):
        self.server.connections = threading.BoundedSemaphore(1)
        stalled = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            stalled.putrequest("POST", "/api/evaluate")
            stalled.putheader("Content-Type", "application/json")
            stalled.putheader("Content-Length", "100")
            stalled.endheaders(); stalled.send(b"{")
            deadline = time.perf_counter() + 1
            while self.server.connections._value and time.perf_counter() < deadline:
                time.sleep(0.001)
            code, result = self.request("GET", "/health")
            self.assertEqual(code, 503)
            self.assertEqual(result["error"], "server_busy")
        finally:
            stalled.close()


class QueueTest(unittest.TestCase):
    def test_one_model_call_at_a_time_with_bounded_pending(self):
        engine = FakeEngine(blocked=True)
        inference = service.InferenceQueue(engine, max_pending=1, timeout=1)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(inference.submit, payload())
                self.assertTrue(engine.started.wait(1))
                second = pool.submit(inference.submit, payload())
                deadline = time.perf_counter() + 1
                while inference.jobs.qsize() != 1 and time.perf_counter() < deadline:
                    time.sleep(0.001)
                with self.assertRaises(service.APIError) as raised:
                    inference.submit(payload())
                self.assertEqual(raised.exception.code, "queue_full")
                engine.release.set()
                first.result(timeout=1); second.result(timeout=1)
            self.assertEqual(engine.peak_active, 1)
            self.assertEqual(engine.calls, 2)
        finally:
            engine.release.set(); inference.close()

    def test_timed_out_pending_job_is_not_executed_later(self):
        engine = FakeEngine(blocked=True)
        inference = service.InferenceQueue(engine, max_pending=1, timeout=0.08)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                first = pool.submit(inference.submit, payload())
                self.assertTrue(engine.started.wait(1))
                with self.assertRaises(service.APIError) as second_error:
                    inference.submit(payload())
                self.assertEqual(second_error.exception.code, "request_timeout")
                with self.assertRaises(service.APIError):
                    first.result(timeout=1)
            engine.release.set()
            deadline = time.perf_counter() + 1
            while inference.jobs.unfinished_tasks and time.perf_counter() < deadline:
                time.sleep(0.001)
            self.assertEqual(engine.calls, 1)
        finally:
            engine.release.set(); inference.close()


class ReadoutTest(unittest.TestCase):
    def engine(self):
        class Native:
            calls = 0
            m = SimpleNamespace(tok=SimpleNamespace(encode=lambda text, **kwargs: list(text)))

            def _decide_items(self, requests, **kwargs):
                return requests, [{"ids": list(requests[0][0]) + [0] * 30}]

            def decide(self, *args, **kwargs):
                self.calls += 1
                return [{"probs_list": [0.75, 0.25]}]
        value = service.DeciderEngine.__new__(service.DeciderEngine)
        value.model, value.model_lock, value.metadata = Native(), threading.Lock(), {"actual_backend": "test-fixture"}
        return value

    def test_native_option_order_maps_back_to_ids_without_rule_override(self):
        result = self.engine().evaluate(payload())
        answer = result["results"][0]["answers"][0]
        self.assertEqual(answer["value"], "soon")
        self.assertEqual(answer["distribution"], {"soon": 0.75, "other": 0.25})
        self.assertEqual(answer["margin"], 0.5)
        self.assertFalse(result["domainCalibrated"])

    def test_context_overflow_fails_before_native_inference(self):
        engine = self.engine(); body = payload(); body["state"] = "x" * 2040
        with self.assertRaises(service.APIError) as raised:
            engine.evaluate(body)
        self.assertEqual(raised.exception.status, 422)
        self.assertEqual(engine.model.calls, 0)


if __name__ == "__main__":
    unittest.main()
