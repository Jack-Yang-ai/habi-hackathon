#!/usr/bin/env python3
"""Copy only verified local-inference models into this app's private files.

The parent coordinator installs the APK and controls recording. This script does
neither and does not modify settings, user audio, other apps or the backend.
"""
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
    parser.add_argument("--package", choices=["com.withecho.companion.dev", "com.withecho.companion"], default="com.withecho.companion.dev")
    parser.add_argument("--adb", type=Path, default=ROOT / ".tools/platform-tools/adb")
    parser.add_argument("--bundle", type=Path, default=ROOT / ".tools/local-inference-android")
    args = parser.parse_args()
    files = {n.removeprefix("models/"): f for n, f in json.loads((args.bundle / "bundle-manifest.json").read_text())["files"].items() if n.startswith("models/")}
    if len(files) != 5:
        parser.error("Expected exactly the four locked model files and tokenizer vectors")
    for name, info in files.items():
        path = args.bundle / "models" / name
        if path.stat().st_size != info["bytes"] or digest(path) != info["sha256"]:
            raise ValueError("Model bundle mismatch: " + name)
    prefix = [str(args.adb.resolve()), "-s", args.serial]

    def adb(*command):
        result = subprocess.run([*prefix, *command], text=True, capture_output=True, timeout=240)
        if result.returncode:
            raise RuntimeError(f"Model deployment failed {result.returncode}: {result.stderr[-2000:]} {result.stdout[-2000:]}")
        return result.stdout

    # Confirm only this debuggable app is addressable before staging any files.
    adb("shell", "run-as", args.package, "pwd")
    remote = "/data/local/tmp/echo-local-models-" + uuid.uuid4().hex[:12]
    adb("shell", "mkdir", "-p", remote)
    adb("push", str(args.bundle / "models"), remote + "/")
    commands = ["mkdir -p files/local-models/sensevoice files/local-models/vad files/local-models/decider"]
    for name in files:
        source = shlex.quote(remote + "/models/" + name)
        target = shlex.quote("files/local-models/" + name)
        pending = shlex.quote("files/local-models/" + name + ".pending")
        commands.extend([f"cp {source} {pending}", f"mv {pending} {target}"])
    adb("shell", "run-as " + shlex.quote(args.package) + " sh -c " + shlex.quote(" && ".join(commands)))
    observed = adb("shell", "run-as " + shlex.quote(args.package) + " sha256sum " + " ".join(shlex.quote("files/local-models/" + n) for n in files))
    hashes = {line.split()[1]: line.split()[0] for line in observed.splitlines() if len(line.split()) == 2}
    for name, info in files.items():
        if hashes.get("files/local-models/" + name) != info["sha256"]:
            raise ValueError("App-private model hash mismatch: " + name)
    print(json.dumps({"models_deployed": True, "package": args.package, "files": len(files),
                      "app_private_hashes_verified": True, "staging_directory": remote,
                      "app_started": False, "microphone_started": False}))


if __name__ == "__main__":
    main()
