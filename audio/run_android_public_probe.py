#!/usr/bin/env python3
"""Explicitly push/run only the prepared public-fixture probe on one Android.

Does not request root, install an APK, enable recording, or read user audio.
Run this only from the device owner's coordinated testing session.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import uuid

from audio.fetch_models import ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True, help="Explicit authorized ADB serial")
    parser.add_argument("--adb", type=Path, default=ROOT / ".tools/platform-tools/adb")
    parser.add_argument("--bundle", type=Path, default=ROOT / ".tools/audio-android/bundle")
    parser.add_argument("--output", type=Path, default=ROOT / ".tools/audio-validation/android-public.json")
    args = parser.parse_args()
    manifest = json.loads((args.bundle / "bundle-manifest.json").read_text())
    for name, info in manifest["files"].items():
        path = args.bundle / name
        if not path.is_file() or path.stat().st_size != info["bytes"] or hashlib.sha256(path.read_bytes()).hexdigest() != info["sha256"]:
            raise ValueError(f"Bundle hash mismatch: {name}")
    prefix = [str(args.adb.resolve()), "-s", args.serial]

    def adb(*command, timeout=180):
        result = subprocess.run([*prefix, *command], text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f"ADB probe failed ({result.returncode}): {result.stderr[-4000:]} {result.stdout[-4000:]}")
        return result.stdout

    # Random isolated directory. Never reuses another application's storage.
    remote = "/data/local/tmp/echo-audio-public-" + uuid.uuid4().hex[:12]
    adb("shell", "mkdir", "-p", remote)
    for name in ("lib", "models", "samples", "probe.jar", "bundle-manifest.json"):
        adb("push", str(args.bundle / name), remote + "/")
    names = list(manifest["files"])
    command = "sha256sum " + " ".join(shlex.quote(remote + "/" + name) for name in names)
    remote_hashes = adb("shell", command)
    observed = {line.split()[1]: line.split()[0] for line in remote_hashes.splitlines() if len(line.split()) == 2}
    for name, info in manifest["files"].items():
        if observed.get(remote + "/" + name) != info["sha256"]:
            raise ValueError(f"On-device hash mismatch: {name}")
    results = []
    for mode, fixture in [("sensevoice", "zh.wav"), ("tagging", "music.wav"), ("tagging", "cat.wav")]:
        command = (f"CLASSPATH={shlex.quote(remote + '/probe.jar')} "
                   f"LD_LIBRARY_PATH={shlex.quote(remote + '/lib')} "
                   f"app_process -Djava.library.path={shlex.quote(remote + '/lib')} /system/bin "
                   f"com.withecho.audio.PublicAudioProbe {shlex.quote(remote)} {mode} {fixture}")
        output = adb("shell", command)
        records = [line[len("AUDIO_PROBE_JSON="):] for line in output.splitlines() if line.startswith("AUDIO_PROBE_JSON=")]
        if len(records) != 1:
            raise RuntimeError("Expected one native probe JSON output: " + output[-4000:])
        results.append(json.loads(records[0]))
    report = {"schema_version": 1, "device_model": adb("shell", "getprop", "ro.product.model").strip(),
              "android_sdk": adb("shell", "getprop", "ro.build.version.sdk").strip(),
              "remote_directory": remote, "public_fixture_sha256_verified": True,
              "bundle_sha256": hashlib.sha256((args.bundle / "bundle-manifest.json").read_bytes()).hexdigest(),
              "microphone_started": False, "private_audio_read": False, "results": results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(args.output.resolve()), "remote_directory": remote,
                      "public_samples_completed": len(results), "microphone_started": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
