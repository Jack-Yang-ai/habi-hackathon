"""Host-only schema, bit order and command-boundary tests; no phone operations."""
import copy
import importlib.util
from pathlib import Path
import shlex
import unittest

SPEC = importlib.util.spec_from_file_location("habi_frame_test", Path(__file__).with_name("habi-frame-test.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PatternTests(unittest.TestCase):
    def setUp(self):
        import json
        self.pattern = json.loads((MODULE.ROOT / "contracts/rear-display/habi.json").read_text())

    def test_valid_pattern_exact_bit_order(self):
        MODULE.validate_pattern(self.pattern)
        frame = self.pattern["scenes"]["idle"]["frames"][0]
        packed = MODULE.frame_bytes(frame)
        self.assertEqual(len(packed), 391)
        for y, row in enumerate(frame["rows"]):
            for x, dot in enumerate(row):
                self.assertEqual(packed[y * 17 + x], 255 if dot == "#" else 0)

    def test_custom_named_pattern_allowed(self):
        pattern = copy.deepcopy(self.pattern)
        pattern["patternId"] = "custom-eating-v1"
        pattern["scenes"] = {"eating": pattern["scenes"]["idle"]}
        MODULE.validate_pattern(pattern)

    def test_reject_malformed_or_reversed_masks(self):
        self.pattern["scenes"]["idle"]["frames"][0]["rowBitmasks"][2] = 1
        with self.assertRaises(ValueError):
            MODULE.validate_pattern(self.pattern)

    def test_schema_rejects_scene_and_id_injection(self):
        for field, value in (("patternId", "bad;id"), ("width", 18)):
            changed = copy.deepcopy(self.pattern)
            changed[field] = value
            with self.assertRaises(ValueError):
                MODULE.validate_pattern(changed)
        self.pattern["scenes"]["eating;id"] = self.pattern["scenes"].pop("idle")
        with self.assertRaises(ValueError):
            MODULE.validate_pattern(self.pattern)

    def test_command_is_fixed_and_every_argument_round_trips(self):
        remote = "/data/local/tmp/habi-frame-" + "ab" * 12
        script = MODULE.remote_script(remote, "eating", 0, "0" * 64, True)
        parts = shlex.split(script)
        self.assertEqual(parts[:3], ["CLASSPATH=" + remote + "/probe.jar", "/system/bin/app_process", "/system/bin"])
        self.assertEqual(parts[-5:], ["eating", "0", "8", "0" * 64, "wake"])
        for invalid in (remote + ";id", "/data/local/tmp/../x", remote + "$(id)"):
            with self.assertRaises(ValueError):
                MODULE.remote_script(invalid, "eating", 0, "0" * 64)
        with self.assertRaises(ValueError):
            MODULE.remote_script(remote, "eating;id", 0, "0" * 64)


if __name__ == "__main__":
    unittest.main()
