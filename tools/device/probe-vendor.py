#!/usr/bin/env python3
"""Compile/run the fixed, read-only StepX shell probe. No root or device settings writes."""
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]

def main():
    jdk = next((ROOT / ".tools/jdk").glob("*/Contents/Home"))
    sdk = ROOT / ".tools/android-sdk"
    work = ROOT / ".tools/vendor-probe"
    classes = work / "classes"
    classes.mkdir(parents=True, exist_ok=True)
    android = sdk / "platforms/android-35/android.jar"
    subprocess.run([str(jdk / "bin/javac"), "--release", "8", "-cp", str(android), "-d", str(classes), str(ROOT / "tools/device/StepXReadOnlyProbe.java")], check=True)
    jar = work / "probe.jar"
    subprocess.run([str(jdk / "bin/java"), "-cp", str(sdk / "build-tools/35.0.0/lib/d8.jar"), "com.android.tools.r8.D8", "--min-api", "26", "--lib", str(android), "--output", str(jar), str(classes / "com/withecho/device/StepXReadOnlyProbe.class")], check=True)
    adb = str(ROOT / ".tools/platform-tools/adb")
    remote = "/data/local/tmp/echo-readonly-probe-" + uuid.uuid4().hex[:12] + ".jar"
    try:
        subprocess.run([adb, "push", str(jar), remote], check=True, timeout=15)
        # Every component in this command is fixed, except the hex-only filename generated here.
        result = subprocess.run([adb, "shell", "CLASSPATH=" + remote + " app_process /system/bin com.withecho.device.StepXReadOnlyProbe"], capture_output=True, text=True, timeout=8)
        (work / "receipt.txt").write_text(result.stdout + result.stderr)
        print(result.stdout, result.stderr)
        result.check_returncode()
    finally:
        subprocess.run([adb, "shell", "rm " + remote], timeout=8, check=False)

if __name__ == "__main__":
    main()
