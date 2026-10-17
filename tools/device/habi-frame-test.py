#!/usr/bin/env python3
"""Compile a fixed eight-second Habi frame probe; pass --run to operate one phone.

The independent phone guard restores only a matching UID/frame hash and remains
alive for delayed persistence. No direct Settings writes, display mode changes,
root or command endpoint. The vendor Binder API persists frames to Settings.
Binder submission is not physical visual validation.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
CLASS = "com.withecho.device.HabiFrameProbe"


def validate_pattern(data):
    if (data.get("schemaVersion"), data.get("brand"), data.get("width"), data.get("height"), data.get("format")) != (2, "Habi", 17, 23, "row-bitmask-msb-left") or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", data.get("patternId", "")):
        raise ValueError("Unexpected Habi frame schema")
    scenes = data.get("scenes", {})
    if not isinstance(scenes, dict) or not 1 <= len(scenes) <= 12 or any(not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", name) for name in scenes):
        raise ValueError("Invalid named pattern scenes")
    count = 0
    for name, scene in scenes.items():
        frames = scene.get("frames", [])
        if type(scene.get("loop")) is not bool or not 1 <= len(frames) <= 32:
            raise ValueError("Invalid scene sequence: " + name)
        for frame in frames:
            rows, masks = frame.get("rows", []), frame.get("rowBitmasks", [])
            if len(rows) != 23 or len(masks) != 23 or type(frame.get("durationMs")) is not int or not 120 <= frame["durationMs"] <= 10000:
                raise ValueError("Invalid frame dimensions or duration")
            for row, mask in zip(rows, masks):
                if not isinstance(row, str) or not re.fullmatch(r"[.#]{17}", row) or type(mask) is not int:
                    raise ValueError("Invalid pixels or bitmask")
                if mask != sum(1 << (16 - x) for x, value in enumerate(row) if value == "#"):
                    raise ValueError("Frame MSB-left bit order mismatch")
            count += 1
    if count > 128:
        raise ValueError("Too many pattern frames")
    return data


def frame_bytes(frame):
    return bytes(((row >> (16 - x)) & 1) * 255 for row in frame["rowBitmasks"] for x in range(17))


def remote_script(remote, scene, index, digest, wake=False):
    if not re.fullmatch(r"/data/local/tmp/habi-frame-[0-9a-f]{24}", remote) or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", scene) or type(index) is not int or not 0 <= index <= 31 or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid fixed probe arguments")
    # Each token is shell quoted; paths are generated hex-only and no free-form command is accepted.
    return "CLASSPATH=" + shlex.quote(remote + "/probe.jar") + " " + shlex.join([
        "/system/bin/app_process", "/system/bin", CLASS, "controller", remote,
        scene, str(index), "8", digest, "wake" if wake else "no-wake",
    ])


def run(command, *, timeout=30, check=True):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "command failed").strip()[:700])
    return result


def compile_probe(logdir):
    jdk = next((ROOT / ".tools/jdk").glob("*/Contents/Home"))
    sdk = ROOT / ".tools/android-sdk"
    source = ROOT / "tools/device/HabiFrameProbe.java"
    classes = logdir / "classes"
    classes.mkdir()
    android = sdk / "platforms/android-35/android.jar"
    compiled = run([str(jdk / "bin/javac"), "--release", "8", "-cp", str(android), "-d", str(classes), str(source)])
    (logdir / "javac.txt").write_text(compiled.stdout + compiled.stderr)
    jar = logdir / "probe.jar"
    dex = run([str(jdk / "bin/java"), "-cp", str(sdk / "build-tools/35.0.0/lib/d8.jar"),
               "com.android.tools.r8.D8", "--min-api", "26", "--lib", str(android), "--output", str(jar),
               *[str(path) for path in sorted(classes.rglob("*.class"))]])
    (logdir / "d8.txt").write_text(dex.stdout + dex.stderr)
    return jar


def select_device(adb, serial):
    devices = run([adb, "devices"]).stdout.splitlines()[1:]
    ready = [line.split()[0] for line in devices if line.endswith("\tdevice")]
    if serial:
        if serial not in ready:
            raise ValueError("Requested serial is not an authorized online device")
        return serial
    if len(ready) != 1:
        raise ValueError("Connect one authorized phone, or pass --serial")
    return ready[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Run the bounded experiment; default only compiles")
    parser.add_argument("--adb", default=str(ROOT / ".tools/platform-tools/adb"))
    parser.add_argument("--serial")
    parser.add_argument("--pattern", type=Path, default=ROOT / "contracts/rear-display/habi.json", help="Local validated 17x23 pattern JSON")
    parser.add_argument("--scene", default="idle")
    parser.add_argument("--frame-index", type=int, default=0)
    parser.add_argument("--seconds", type=int, choices=[8], default=8, help="Only 8 seconds: 3 seconds cannot verify the 5-second persistence window")
    parser.add_argument("--wake", action="store_true", help="Request one policy-respecting vendor wake; no pixel/power override")
    args = parser.parse_args()
    source = args.pattern.resolve()
    source_bytes = source.read_bytes()
    pattern = validate_pattern(json.loads(source_bytes))
    if args.scene not in pattern["scenes"]:
        parser.error("scene is not in the validated local pattern")
    frames = pattern["scenes"][args.scene]["frames"]
    if not 0 <= args.frame_index < len(frames):
        parser.error("frame-index is outside this scene")
    logdir = ROOT / ".tools/device-diagnostics" / ("habi-frame-test-" + dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    logdir.mkdir(parents=True)
    jar = compile_probe(logdir)
    digest = hashlib.sha256(source_bytes).hexdigest()
    receipt = {"compiled": True, "ranOnPhone": False, "patternId": pattern["patternId"], "scene": args.scene, "frameIndex": args.frame_index,
               "seconds": 8, "hardLimitSeconds": 30, "patternSha256": digest,
               "frameSha256": hashlib.sha256(frame_bytes(frames[args.frame_index])).hexdigest(),
               "jarSha256": hashlib.sha256(jar.read_bytes()).hexdigest(), "physicalVisualConfirmed": False,
               "directSettingsWrites": False, "vendorPersistsFrame": True, "logDirectory": str(logdir)}
    (logdir / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    if not args.run:
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
        return 0
    serial = select_device(args.adb, args.serial)
    base = [args.adb, "-s", serial]
    remote = "/data/local/tmp/habi-frame-" + uuid.uuid4().hex[:24]
    run(base + ["shell", "mkdir", "-m", "700", remote])
    run(base + ["push", str(jar), remote + "/probe.jar"])
    run(base + ["push", str(source), remote + "/habi.json"])
    run(base + ["shell", "chmod", "600", remote + "/probe.jar", remote + "/habi.json"])
    receipt.update({"ranOnPhone": True, "remoteDirectory": remote})
    (logdir / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    print("Running one 8-second static Habi frame. Independent guard retains up to 30 seconds for cleanup.", flush=True)
    started = time.monotonic()
    try:
        result = run(base + ["shell", remote_script(remote, args.scene, args.frame_index, digest, args.wake)], timeout=35, check=False)
        (logdir / "controller.txt").write_text(result.stdout + result.stderr)
        receipt["controllerExitCode"] = result.returncode
    except (KeyboardInterrupt, subprocess.TimeoutExpired) as error:
        # The remote guard continues without the host, expires and checks ownership itself.
        receipt["hostInterrupted"] = type(error).__name__
        print("Host interrupted; the independent phone guard retains responsibility for cleanup.", flush=True)
    # Fetch only this generated directory. Never kill arbitrary PIDs or blindly clear from the host.
    result_data = None
    while time.monotonic() - started < 34:
        fetched = run(base + ["shell", "cat", remote + "/result.json"], timeout=4, check=False)
        if fetched.returncode == 0:
            try:
                result_data = json.loads(fetched.stdout)
                break
            except ValueError:
                pass
        time.sleep(0.5)
    for name in ("owner.json", "journal.json", "guard.json", "result.json", "guard.log", "guard-events.ndjson", "controller-events.ndjson"):
        downloaded = run(base + ["pull", remote + "/" + name, str(logdir / name)], timeout=5, check=False)
        if downloaded.returncode:
            receipt.setdefault("unavailableLogs", []).append(name)
    receipt["result"] = result_data
    (logdir / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    # Keep the remote directory/journal so a failed cleanup remains reviewable.
    return 0 if result_data and result_data.get("ok") else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, FileNotFoundError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
