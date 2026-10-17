#!/usr/bin/env python3
"""Prepare an arm64 public-fixture-only Android probe without touching any phone.

Reuses this workspace's Android SDK 35, JDK 17 and cached Kotlin 2.1.10 compiler.
Outputs a self-contained .tools/audio-android/bundle for the device owner to run.
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import urllib.request

from audio.fetch_models import ROOT, DEFAULT_DIRECTORY, fetch_asset, matches

WORK = ROOT / ".tools/audio-android"
LOCK = Path(__file__).with_name("android-runtime.lock.json")


def ensure_download(path, info):
    if matches(path, info):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".partial")
    try:
        total = 0
        with urllib.request.urlopen(info["url"], timeout=60) as source, partial.open("wb") as target:
            while True:
                block = source.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > info["bytes"]:
                    raise ValueError("Download exceeds locked size")
                target.write(block)
        if not matches(partial, info):
            raise ValueError("Android runtime/source hash mismatch")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def cached_jar(name, version, group="org.jetbrains.kotlin"):
    base = ROOT / ".tools/gradle-cache/caches/modules-2/files-2.1" / group / name / version
    files = list(base.glob("*/*.jar"))
    if len(files) != 1:
        raise FileNotFoundError(f"Expected one cached {group}:{name}:{version} JAR in {base}")
    return files[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java-home", type=Path)
    parser.add_argument("--sdk", type=Path, default=ROOT / ".tools/android-sdk")
    args = parser.parse_args()
    java_home = args.java_home
    if java_home is None:
        choices = list((ROOT / ".tools/jdk").glob("*/Contents/Home"))
        if len(choices) != 1:
            parser.error("Supply --java-home when zero/multiple workspace JDKs exist")
        java_home = choices[0]
    java = java_home / "bin/java"
    jar = java_home / "bin/jar"
    android_jar = args.sdk / "platforms/android-35/android.jar"
    d8 = args.sdk / "build-tools/35.0.0/lib/d8.jar"
    for path in (java, jar, android_jar, d8):
        if not path.is_file():
            parser.error(f"Missing toolchain file: {path}")

    lock = json.loads(LOCK.read_text())
    probe_source = Path(__file__).with_name("android") / "PublicAudioProbe.kt"
    if f"sherpa-onnx-{lock['version']}-android-arm64" not in probe_source.read_text():
        raise ValueError("Probe runtime label must match android-runtime.lock.json")
    source_dir = WORK / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    for name, info in lock["sources"].items():
        ensure_download(source_dir / name, info)
    runtime = lock["runtime"]
    archive = DEFAULT_DIRECTORY / runtime["name"]
    ensure_download(archive, runtime)
    bundle = WORK / "bundle"
    (bundle / "lib").mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:bz2") as source:
        for member in source.getmembers():
            name = str(PurePosixPath(member.name))
            if name not in runtime["files"]:
                continue
            info = runtime["files"][name]
            if not member.isfile() or member.size != info["bytes"]:
                raise ValueError("Unexpected native library member")
            target = bundle / "lib" / PurePosixPath(name).name
            if not matches(target, info):
                with source.extractfile(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
            if not matches(target, info):
                raise ValueError("Native library hash mismatch")

    models = json.loads(Path(__file__).with_name("models.lock.json").read_text())
    for asset in models["assets"]:
        directory = fetch_asset(asset, DEFAULT_DIRECTORY)
        alias = "sensevoice" if asset["id"] == "sensevoice_int8" else "tagging"
        output_dir = bundle / "models" / alias
        output_dir.mkdir(parents=True, exist_ok=True)
        names = ["model.int8.onnx", "tokens.txt" if alias == "sensevoice" else "class_labels_indices.csv"]
        for name in names:
            target = output_dir / name
            if not matches(target, asset["files"][name]):
                shutil.copyfile(directory / name, target)
    samples = bundle / "samples"
    samples.mkdir(parents=True, exist_ok=True)
    for alias, model_id, wave in [("zh.wav", "sensevoice_int8", "zh.wav"),
                                  ("music.wav", "zipformer_audio_tagging_int8", "3.wav"),
                                  ("cat.wav", "zipformer_audio_tagging_int8", "1.wav")]:
        asset = next(a for a in models["assets"] if a["id"] == model_id)
        shutil.copyfile(DEFAULT_DIRECTORY / asset["directory"] / "test_wavs" / wave, samples / alias)

    compiler = [cached_jar("kotlin-compiler-embeddable", "2.1.10"),
                cached_jar("kotlin-stdlib", "2.1.10"), cached_jar("kotlin-script-runtime", "2.1.10"),
                cached_jar("kotlin-reflect", "1.6.10"), cached_jar("kotlin-daemon-embeddable", "2.1.10"),
                cached_jar("trove4j", "1.0.20200330", "org.jetbrains.intellij.deps"),
                cached_jar("kotlinx-coroutines-core-jvm", "1.6.4", "org.jetbrains.kotlinx"),
                cached_jar("annotations", "13.0", "org.jetbrains")]
    # Build-tools 35 D8 understands Kotlin metadata up to 2.0; match the runtime
    # library and emitted language metadata instead of producing warning floods.
    stdlib = cached_jar("kotlin-stdlib", "2.0.20")
    classes = WORK / "classes"
    if classes.exists():
        shutil.rmtree(classes)
    classes.mkdir(parents=True)
    subprocess.run([str(java), "-Xmx1g", "-cp", ":".join(map(str, compiler)),
                    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect",
                    "-language-version", "2.0", "-jvm-target", "1.8", "-classpath", f"{android_jar}:{stdlib}",
                    "-d", str(classes), *map(str, sorted(source_dir.glob("*.kt"))),
                    str(probe_source)], check=True)
    class_jar = WORK / "classes.jar"
    subprocess.run([str(jar), "cf", str(class_jar), "-C", str(classes), "."], check=True)
    subprocess.run([str(java), "-Xmx1g", "-cp", str(d8), "com.android.tools.r8.D8",
                    "--min-api", "26", "--lib", str(android_jar), "--output", str(bundle / "probe.jar"),
                    str(class_jar), str(stdlib)], check=True)
    manifest = {"schema_version": 1, "runtime_version": lock["version"],
                "source_commit": lock["source_commit"], "files": {}}
    for path in sorted(bundle.rglob("*")):
        if path.is_file() and path.name != "bundle-manifest.json":
            manifest["files"][str(path.relative_to(bundle))] = {
                "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    (bundle / "bundle-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"bundle": str(bundle), "bytes": sum(f["bytes"] for f in manifest["files"].values()),
                      "phone_touched": False, "microphone_started": False}))


if __name__ == "__main__":
    main()
