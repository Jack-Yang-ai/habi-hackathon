#!/usr/bin/env python3
"""Development-only App -> ADB -> StepX dot-matrix state relay.

Only named scenes are accepted. This process cannot run arbitrary shell commands,
does not change persistent back-screen settings, and respects OS posture/thermal gates.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import fcntl
from pathlib import Path
import re
import subprocess
import sys
import signal
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SCENES = {
    "idle": "idle",
    "collecting": "executing",
    "resting": "idle_night",
    "watering": "idle_loafing",
    "listening": "listening",
}


class Relay:
    def __init__(self, args):
        self.args = args
        self.base = [args.adb]
        if args.serial:
            self.base += ["-s", args.serial]
        self.last_scene = None
        self.changed = False
        self.phone_id = "phone-unknown"
        self.model = "unknown"
        self.os_version = "unknown"
        self.root_available = False
        self.last_mapped = None
        self.last_wake = -60.0

    def adb(self, *args):
        result = subprocess.run(self.base + list(args), capture_output=True, text=True, timeout=8)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout).strip()[:300])
        return result.stdout.strip()

    def request(self, path, data=None):
        headers = {"Accept": "application/json"}
        if os.environ.get("APP_ACCESS_TOKEN"):
            headers["X-App-Token"] = os.environ["APP_ACCESS_TOKEN"]
        if os.environ.get("DEVICE_ACCESS_TOKEN"):
            headers["X-Device-Token"] = os.environ["DEVICE_ACCESS_TOKEN"]
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode()
        request = urllib.request.Request(self.args.server.rstrip("/") + path, data=body, headers=headers)
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def probe(self):
        devices = self.adb("devices").splitlines()[1:]
        ready = [line.split()[0] for line in devices if line.endswith("\tdevice")]
        if not self.args.serial and len(ready) != 1:
            raise RuntimeError("Connect one authorized Android phone, or pass --serial.")
        serial = self.args.serial or ready[0]
        self.phone_id = "phone-" + hashlib.sha256(serial.encode()).hexdigest()[:12]
        self.model = self.adb("shell", "getprop ro.product.model")
        self.os_version = "Android " + self.adb("shell", "getprop ro.build.version.release")
        # No privileged request is made on each poll. This checks the existing shell uid only.
        self.root_available = "uid=0" in self.adb("shell", "id")
        help_text = self.adb("shell", "dumpsys display_ext back_screen help")
        if "Back-screen commands:" not in help_text:
            raise RuntimeError("This phone has no supported StepX back-screen debug interface.")

    def read_status(self):
        text = self.adb("shell", "dumpsys display_ext back_screen")
        def match(pattern, default=None):
            found = re.search(pattern, text, re.MULTILINE)
            return found.group(1) if found else default
        return {
            "device_id": self.phone_id,
            "model": self.model,
            "os": self.os_version,
            "rootAvailable": self.root_available,
            "rearDisplay": "adb-relay",
            "requiresCable": True,
            "requestedScene": self.last_scene,
            "mappedState": SCENES.get(self.last_scene),
            "rearPower": match(r"^  power=(\w+)", "unknown"),
            "rearPolicyAllowsOutput": match(r"^  policyAllowsOutput=(\w+)") == "true",
            "rearAppliedState": match(r"^  appliedAgentState=(\S+)", "unknown"),
            "hardwarePresent": "chipProbe=present" in text,
            "physicalVisualConfirmed": False,
            "customFramePresent": "appUsesCustomFrame=true" in text or "appliedCustomFrame=true" in text,
            "agentStateOwnerUid": match(r"^  agentStateOwner=uid=(\d+)"),
            "agentState": match(r"^  appAgentState=(\S+)"),
            "agentAnimationActive": match(r"^  currentAnimInfo=(.+)", "null") != "null",
            "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }

    def apply(self, scene):
        if scene not in SCENES:
            raise ValueError("unknown_scene")
        if scene == self.last_scene:
            return
        before = self.read_status()
        if before["customFramePresent"]:
            print("Rear display preserved: an existing custom frame belongs to another controller.", flush=True)
            return
        # Yield to a live system/third-party interaction. Resting resident states
        # can be replaced, but recording/call/assistant animations keep priority.
        resident = {"idle", "idle_night", "idle_loafing", "fallback"}
        if before["agentStateOwnerUid"] not in {None, "2000"} and before["agentState"] not in resident and before["agentAnimationActive"]:
            print("Rear display preserved: another owner has an active interaction.", flush=True)
            return
        state = SCENES[scene]
        result = self.adb("shell", "dumpsys display_ext back_screen state " + state)
        # Quiet resident states never force screen-off or an always-on loop.
        # Interaction changes request one wake, capped to once per 30 seconds.
        if scene in {"collecting", "listening", "watering"} and time.monotonic() - self.last_wake >= 30:
            self.adb("shell", "dumpsys display_ext back_screen wake")
            self.last_wake = time.monotonic()
        self.changed = True
        self.last_scene = scene
        self.last_mapped = state
        time.sleep(0.3)  # vendor agent-state debouncing; submission is not immediate application
        print(json.dumps({"scene": scene, "mapped_state": state, "result": result}, ensure_ascii=False), flush=True)

    def run(self):
        self.probe()
        if self.args.scene:
            self.apply(self.args.scene)
            status = self.read_status()
            print(json.dumps(status, ensure_ascii=False, indent=2))
            return
        last_report = 0
        print("ADB relay ready. Rear display obeys posture, sleep and thermal gates. Ctrl-C stops it.", flush=True)
        while True:
            try:
                state = self.request("/api/state")
                scene = state.get("companion", {}).get("scene", "idle")
                until = state.get("companion", {}).get("sceneUntil")
                if scene in {"collecting", "listening", "watering"} and until:
                    try:
                        expiry = dt.datetime.fromisoformat(until.replace("Z", "+00:00"))
                        if expiry <= dt.datetime.now(dt.timezone.utc):
                            scene = "idle"
                    except (ValueError, TypeError):
                        scene = "idle"
                if isinstance(scene, str) and scene in SCENES:
                    self.apply(scene)
                if time.monotonic() - last_report >= 10:
                    self.request("/api/phone/status", self.read_status())
                    last_report = time.monotonic()
            except (urllib.error.URLError, RuntimeError, KeyError, ValueError) as error:
                print("Relay waiting: " + str(error), file=sys.stderr, flush=True)
            time.sleep(self.args.interval)

    def close(self):
        if self.changed and not self.args.keep_scene:
            try:
                current = self.read_status()
                # The debug state setter reports owner=none on this firmware.
                # We never send a custom frame or clear any custom frame here.
                if not current["customFramePresent"] and current["agentStateOwnerUid"] in {None, "2000"} and current["agentState"] == self.last_mapped:
                    self.adb("shell", "dumpsys display_ext back_screen state reset")
            except (RuntimeError, subprocess.TimeoutExpired):
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", default=str(ROOT / ".tools/platform-tools/adb"))
    parser.add_argument("--serial")
    parser.add_argument("--server", default="http://127.0.0.1:8787")
    parser.add_argument("--interval", type=float, default=2)
    parser.add_argument("--scene", choices=tuple(SCENES), help="Apply one bounded test scene and print actual OS status.")
    parser.add_argument("--keep-scene", action="store_true", help="Leave the test state for the OS to expire; normally restore idle on exit.")
    parser.add_argument("--stop", action="store_true", help="Stop only the relay recorded by this workspace.")
    args = parser.parse_args()
    pid_file = ROOT / ".tools/device-relay.pid"
    if args.stop:
        if not pid_file.exists():
            print("No workspace relay PID recorded."); return
        pid = int(pid_file.read_text().strip())
        process = subprocess.run(["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True)
        if process.returncode or "tools/device/relay.py" not in process.stdout:
            raise SystemExit("PID identity mismatch; no process stopped.")
        # A reused PID running another checkout must not be signalled.
        cwd = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True)
        if ("n" + str(ROOT)) not in cwd.stdout.splitlines():
            raise SystemExit("Workspace identity mismatch; no process stopped.")
        os.kill(pid, signal.SIGTERM)
        print("Stop requested for this workspace relay."); return
    if not 0.5 <= args.interval <= 60:
        parser.error("interval must be between 0.5 and 60 seconds")
    if urllib.parse.urlparse(args.server).scheme not in {"http", "https"}:
        parser.error("server must be an HTTP(S) origin")
    relay = Relay(args)
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    lock = open(ROOT / ".tools/device-relay.lock", "a+")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another relay already owns this workspace lock.")
    pid_file.write_text(str(os.getpid()))
    def stop(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    try:
        relay.run()
    except KeyboardInterrupt:
        print("Stopping relay.")
    finally:
        relay.close()
        if pid_file.exists() and pid_file.read_text().strip() == str(os.getpid()):
            pid_file.unlink()
        lock.close()


if __name__ == "__main__":
    main()
