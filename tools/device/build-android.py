#!/usr/bin/env python3
"""Build the native development host; Gradle runs npm run build for packaged Studio assets."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]

def require_idle_recorder(adb):
    """Package updates kill an active capture without giving it a STOP callback."""
    probe = subprocess.run([str(adb), 'shell', 'dumpsys', 'activity', 'services', 'com.withecho.companion.dev'],
                           capture_output=True, text=True, timeout=10, check=True)
    for block in re.split(r'(?=\* ServiceRecord\{)', probe.stdout):
        if 'com.withecho.companion.RecordingService' in block and 'isForeground=true' in block:
            raise ValueError('Phone recording/voice-camera is active. Stop it in Habi before installing an APK; package updates interrupt capture.')

def verify_inference_bundle():
    bundle = ROOT / '.tools/local-inference-android'
    manifest_path = bundle / 'bundle-manifest.json'
    if not manifest_path.is_file():
        raise ValueError('Prepare phone inference first: python3 tools/decision/prepare-android-local.py --install-toolchain')
    manifest = json.loads(manifest_path.read_text())
    lock = ROOT / 'tools/decision/android-local.lock.json'
    if manifest.get('lock_sha256') != hashlib.sha256(lock.read_bytes()).hexdigest():
        raise ValueError('Phone inference lock changed; rerun prepare-android-local.py')
    for name in ('libecho-decider.so', 'libc++_shared.so', 'libsherpa-onnx-jni.so', 'libonnxruntime.so'):
        relative = 'jniLibs/arm64-v8a/' + name
        expected = manifest.get('files', {}).get(relative)
        path = bundle / relative
        if not expected or not path.is_file() or path.stat().st_size != expected['bytes']:
            raise ValueError('Missing matching inference library: ' + name)
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected['sha256']:
            raise ValueError('Inference library hash differs: ' + name)
    for name in ('OfflineRecognizer.kt', 'OfflineStream.kt', 'FeatureConfig.kt', 'HomophoneReplacerConfig.kt', 'QnnConfig.kt', 'Vad.kt'):
        if not (bundle / 'sherpa-source' / name).is_file():
            raise ValueError('Missing sherpa Kotlin source: ' + name)
    kws_lock = json.loads((ROOT / 'contracts/voice-kws/kws-lock.json').read_text())
    for name, info in kws_lock['sources'].items():
        source = bundle / 'sherpa-source' / name
        if not source.is_file() or source.stat().st_size != info['bytes'] or hashlib.sha256(source.read_bytes()).hexdigest() != info['sha256']:
            raise ValueError('Prepare matching KWS bindings: python3 tools/decision/prepare-android-kws.py')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java-home", type=Path)
    parser.add_argument("--sdk", type=Path, default=ROOT / ".tools/android-sdk")
    parser.add_argument("--gradle", type=Path, default=ROOT / ".tools/gradle-8.11.1/bin/gradle")
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--adb", type=Path, default=ROOT / ".tools/platform-tools/adb")
    args = parser.parse_args()
    if args.install:
        try: require_idle_recorder(args.adb)
        except (OSError, ValueError, subprocess.SubprocessError) as failure: parser.error(str(failure))
    try:
        verify_inference_bundle()
    except (OSError, ValueError, KeyError) as failure:
        parser.error(str(failure))
    if not shutil.which("node") or not shutil.which("npm"):
        parser.error("Supply Node >=22.16 and npm on PATH, then run npm ci at the repository root.")
    try:
        version = subprocess.run(["node", "--version"], capture_output=True, text=True, check=True).stdout.strip()
        node_version = tuple(int(part) for part in version.removeprefix("v").split(".")[:2])
        if node_version < (22, 16):
            parser.error("Node >=22.16 is required; select a supported Node version on PATH.")
    except (OSError, ValueError, subprocess.SubprocessError) as failure:
        parser.error("Cannot verify Node on PATH: " + str(failure))
    jdk = args.java_home
    if jdk is None:
        matches = list((ROOT / ".tools/jdk").glob("*/Contents/Home"))
        if matches:
            jdk = matches[0]
        elif os.environ.get("JAVA_HOME"):
            jdk = Path(os.environ["JAVA_HOME"])
    if jdk is None or not (jdk / "bin/java").exists():
        parser.error("Supply a JDK 17+ using --java-home or JAVA_HOME.")
    if not args.gradle.exists() or not (args.sdk / "platforms/android-35/android.jar").exists():
        parser.error("Install Gradle 8.11.1, Android platform 35 and build-tools 35.0.0 first; see android/README.md.")
    (ROOT / "android/local.properties").write_text("sdk.dir=" + str(args.sdk.resolve()) + "\n")
    env = dict(os.environ, JAVA_HOME=str(jdk.resolve()), GRADLE_USER_HOME=str(ROOT / ".tools/gradle-cache"))
    print("Gradle will run npm run build before syncing Studio into APK assets/studio/.", flush=True)
    subprocess.run([str(args.gradle.resolve()), "--no-daemon", "--console=plain", ":app:assembleDebug"], cwd=ROOT / "android", env=env, check=True)
    apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
    print("APK:", apk)
    if args.install:
        try: require_idle_recorder(args.adb)
        except (OSError, ValueError, subprocess.SubprocessError) as failure: parser.error(str(failure))
        subprocess.run([str(args.adb), "install", "-r", str(apk)], check=True)
        subprocess.run([str(args.adb), "reverse", "tcp:8787", "tcp:8787"], check=True)
        subprocess.run([str(args.adb), "shell", "am start -n com.withecho.companion.dev/com.withecho.companion.MainActivity"], check=True)

if __name__ == "__main__":
    main()
