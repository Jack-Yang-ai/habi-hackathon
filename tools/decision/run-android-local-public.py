#!/usr/bin/env python3
"""Run pinned public/silent files in an isolated Android app_process, never a mic."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--adb", type=Path, default=ROOT / ".tools/platform-tools/adb")
    parser.add_argument("--bundle", type=Path, default=ROOT / ".tools/local-inference-android")
    parser.add_argument("--output", type=Path, default=ROOT / "output/validation/android-local-inference-public.json")
    args = parser.parse_args()
    manifest_path = args.bundle / "bundle-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for name in ("jniLibs/arm64-v8a/libecho-decider.so", "jniLibs/arm64-v8a/libonnxruntime.so", "probe.jar"):
        if name not in manifest["files"]:
            parser.error("Incomplete native bundle; finish prepare-android-local.py first")
    for name, info in manifest["files"].items():
        path = args.bundle / name
        if path.stat().st_size != info["bytes"] or digest(path) != info["sha256"]:
            raise ValueError("Bundle hash mismatch: " + name)
    prefix = [str(args.adb.resolve()), "-s", args.serial]

    def adb(*command, timeout=240):
        result = subprocess.run([*prefix, *command], text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f"Public probe ADB failure {result.returncode}: {result.stderr[-6000:]} {result.stdout[-6000:]}")
        return result.stdout

    remote = "/data/local/tmp/echo-local-public-" + uuid.uuid4().hex[:12]
    report = {"schema_version": 1, "remote_directory": remote,
              "bundle_manifest_sha256": digest(manifest_path), "microphone_started": False,
              "private_audio_read": False, "app_installed_or_restarted": False,
              "camera_started": False, "network_used_by_probe": False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        adb("shell", "mkdir", "-p", remote)
        for name in ("jniLibs", "models", "samples", "probe.jar", "bundle-manifest.json"):
            adb("push", str(args.bundle / name), remote + "/")
        observed = adb("shell", "sha256sum " + " ".join(shlex.quote(remote + "/" + n) for n in manifest["files"]))
        hashes = {line.split()[1]: line.split()[0] for line in observed.splitlines() if len(line.split()) == 2}
        for name, info in manifest["files"].items():
            if hashes.get(remote + "/" + name) != info["sha256"]:
                raise ValueError("Device bundle hash mismatch: " + name)
        report["device_hashes_verified"] = True
        report["device"] = {key: adb("shell", "getprop", prop).strip() for key, prop in {
            "model": "ro.product.model", "soc": "ro.soc.model", "sdk": "ro.build.version.sdk"}.items()}
        lib = remote + "/jniLibs/arm64-v8a"
        command = (f"CLASSPATH={shlex.quote(remote + '/probe.jar')} LD_LIBRARY_PATH={shlex.quote(lib)} "
                   f"app_process -Djava.library.path={shlex.quote(lib)} /system/bin "
                   f"com.withecho.companion.LocalInferencePublicProbe {shlex.quote(remote)}")
        raw = adb("shell", command)
        marker = "LOCAL_INFERENCE_PUBLIC_JSON="
        records = [line[len(marker):] for line in raw.splitlines() if line.startswith(marker)]
        if len(records) != 1:
            raise RuntimeError("Missing public probe report: " + raw[-6000:])
        report["inference"] = json.loads(records[0])
        report["completed"] = bool(report["inference"].get("completed"))
    except Exception as error:
        report["completed"] = False
        report["error"] = str(error)
        raise
    finally:
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(args.output.resolve()), "completed": report["completed"],
                      "remote_directory": remote, "microphone_started": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
