#!/usr/bin/env python3
"""Verify/download pinned assets and build file-only Android local inference.

Does not touch a phone, start a microphone or modify Gradle/product settings.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import wave

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from audio.build_android_probe import ensure_download, cached_jar
from audio.fetch_models import fetch_asset, matches, DEFAULT_DIRECTORY

HERE = Path(__file__).resolve().parent
OUT = ROOT / ".tools/local-inference-android"


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def copy_verified(source, destination, info=None):
    if info is not None and not matches(source, info):
        raise ValueError(f"Asset hash mismatch: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected = info or {"bytes": source.stat().st_size, "sha256": digest(source)}
    if matches(destination, expected):
        return
    pending = destination.with_name(destination.name + ".pending")
    pending.unlink(missing_ok=True)
    # Hardlinks save host space; on-device installation still copies verified data.
    try:
        os.link(source, pending)
    except OSError:
        shutil.copyfile(source, pending)
    pending.replace(destination)
    if not matches(destination, expected):
        raise ValueError(f"Prepared asset hash mismatch: {destination}")


def build_probe(java_home, sdk, source_dir):
    java, jar = java_home / "bin/java", java_home / "bin/jar"
    android = sdk / "platforms/android-35/android.jar"
    stdlib = cached_jar("kotlin-stdlib", "2.0.20")
    compiler = [cached_jar("kotlin-compiler-embeddable", "2.1.10"),
                cached_jar("kotlin-stdlib", "2.1.10"), cached_jar("kotlin-script-runtime", "2.1.10"),
                cached_jar("kotlin-reflect", "1.6.10"), cached_jar("kotlin-daemon-embeddable", "2.1.10"),
                cached_jar("trove4j", "1.0.20200330", "org.jetbrains.intellij.deps"),
                cached_jar("kotlinx-coroutines-core-jvm", "1.6.4", "org.jetbrains.kotlinx"),
                cached_jar("annotations", "13.0", "org.jetbrains")]
    classes = OUT / "probe-classes"
    if classes.exists():
        shutil.rmtree(classes)
    classes.mkdir(parents=True)
    sources = [*sorted(source_dir.glob("*.kt")),
               ROOT / "android/app/src/main/java/com/withecho/companion/LocalInferenceEngine.kt",
               ROOT / "android/app/src/main/java/com/withecho/companion/VoiceCameraCommands.kt",
               HERE / "android/LocalInferencePublicProbe.kt"]
    subprocess.run([str(java), "-Xmx1g", "-cp", ":".join(map(str, compiler)),
                    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect",
                    "-language-version", "2.0", "-jvm-target", "1.8", "-classpath", f"{android}:{stdlib}",
                    "-d", str(classes), *map(str, sources)], check=True)
    class_jar = OUT / "probe-classes.jar"
    subprocess.run([str(jar), "cf", str(class_jar), "-C", str(classes), "."], check=True)
    subprocess.run([str(java), "-Xmx1g", "-cp", str(sdk / "build-tools/35.0.0/lib/d8.jar"),
                    "com.android.tools.r8.D8", "--min-api", "26", "--lib", str(android),
                    "--output", str(OUT / "probe.jar"), str(class_jar), str(stdlib)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, default=ROOT / ".tools/android-sdk")
    parser.add_argument("--java-home", type=Path)
    parser.add_argument("--install-toolchain", action="store_true")
    parser.add_argument("--skip-native-build", action="store_true")
    parser.add_argument("--skip-probe-build", action="store_true")
    parser.add_argument("--native-only", action="store_true",
                        help="Prepare APK libraries/bindings without models, samples or the standalone probe")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.jobs <= 8:
        parser.error("--jobs must be 1..8")
    jdk = args.java_home or next((ROOT / ".tools/jdk").glob("*/Contents/Home"))
    lock = json.loads((HERE / "android-local.lock.json").read_text())
    ndk = args.sdk / "ndk" / lock["ndk"]
    cmake_dir = args.sdk / "cmake" / lock["cmake"] / "bin"
    if args.install_toolchain:
        # Direct Java invocation handles workspace paths containing spaces.
        subprocess.run([str(jdk / "bin/java"), "-cp", str(args.sdk / "cmdline-tools/latest/lib/sdkmanager-classpath.jar"),
                        "com.android.sdklib.tool.sdkmanager.SdkManagerCli", "--sdk_root=" + str(args.sdk.resolve()),
                        "ndk;" + lock["ndk"], "cmake;" + lock["cmake"]], check=True)
    OUT.mkdir(parents=True, exist_ok=True)

    # Compile exact same llama.cpp revision as the locked desktop Python sdist.
    archive = ROOT / ".tools/llama_cpp_python-0.3.36.tar.gz"
    ensure_download(archive, lock["llama_cpp_python_source"])
    source = ROOT / ".tools/llama-cpp-src"
    source.mkdir(exist_ok=True)
    with tarfile.open(archive, "r:gz") as package:
        prefix = "llama_cpp_python-0.3.36/vendor/llama.cpp/"
        for member in package:
            if not member.name.startswith(prefix) or not member.isfile():
                continue
            relative = PurePosixPath(member.name[len(prefix):])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe llama.cpp source path")
            target = source / relative
            content = package.extractfile(member).read()
            if not target.exists() or target.read_bytes() != content:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
    runtime = json.loads((ROOT / lock["sherpa_runtime_lock"]).read_text())
    kotlin = OUT / "sherpa-source"
    kotlin.mkdir(exist_ok=True)
    for name in ("OfflineRecognizer.kt", "OfflineStream.kt", "FeatureConfig.kt", "HomophoneReplacerConfig.kt", "QnnConfig.kt"):
        ensure_download(kotlin / name, runtime["sources"][name])
    ensure_download(kotlin / "Vad.kt", lock["vad_source"])
    runtime_archive = DEFAULT_DIRECTORY / runtime["runtime"]["name"]
    ensure_download(runtime_archive, runtime["runtime"])
    native = OUT / "jniLibs/arm64-v8a"
    native.mkdir(parents=True, exist_ok=True)
    with tarfile.open(runtime_archive, "r:bz2") as package:
        for member in package:
            name = str(PurePosixPath(member.name))
            info = runtime["runtime"]["files"].get(name)
            if info is None:
                continue
            target = native / PurePosixPath(member.name).name
            if not matches(target, info):
                with package.extractfile(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
            if not matches(target, info):
                raise ValueError("sherpa/ORT runtime hash mismatch")
    for name, info in runtime["runtime"]["files"].items():
        if not matches(native / PurePosixPath(name).name, info):
            raise ValueError("Required matching sherpa/ORT library was not extracted: " + name)

    if not args.native_only:
        models = json.loads((ROOT / lock["audio_models_lock"]).read_text())
        sense = next(a for a in models["assets"] if a["id"] == "sensevoice_int8")
        sense_root = fetch_asset(sense, DEFAULT_DIRECTORY)
        for name in ("model.int8.onnx", "tokens.txt"):
            copy_verified(sense_root / name, OUT / "models/sensevoice" / name, sense["files"][name])
        copy_verified(sense_root / "test_wavs/zh.wav", OUT / "samples/zh.wav", sense["files"]["test_wavs/zh.wav"])
        vad = next(f for f in models["single_files"] if f["id"] == "silero_vad")
        ensure_download(DEFAULT_DIRECTORY / vad["name"], vad)
        copy_verified(DEFAULT_DIRECTORY / vad["name"], OUT / "models/vad" / vad["name"], vad)
        decision = json.loads((ROOT / lock["decider_model_lock"]).read_text())["model"]
        gguf = decision["filename"]
        cached_model = ROOT / ".tools/decider-08b-gguf" / gguf
        ensure_download(cached_model, decision["files"][gguf])
        copy_verified(cached_model, OUT / "models/decider" / gguf, decision["files"][gguf])
        copy_verified(HERE / "android-tokenizer-vectors.json", OUT / "models/tokenizer-vectors.json")
        with wave.open(str(OUT / "samples/silence.wav"), "wb") as silence:
            silence.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            silence.writeframes(b"\0" * (16000 * 2 * 10))

    if not args.skip_native_build:
        cmake = cmake_dir / "cmake"
        ninja = cmake_dir / "ninja"
        for path in (cmake, ninja, ndk / "build/cmake/android.toolchain.cmake"):
            if not path.exists():
                parser.error(f"Missing {path}; run with --install-toolchain")
        build = OUT / "native-build"
        subprocess.run([str(cmake), "-S", str(ROOT / "android/app/src/main/cpp/local_decider"),
                        "-B", str(build), "-G", "Ninja", "-DCMAKE_MAKE_PROGRAM=" + str(ninja),
                        "-DCMAKE_TOOLCHAIN_FILE=" + str(ndk / "build/cmake/android.toolchain.cmake"),
                        "-DANDROID_ABI=arm64-v8a", "-DANDROID_PLATFORM=android-26", "-DANDROID_STL=c++_shared",
                        "-DCMAKE_BUILD_TYPE=Release", "-DLLAMA_SOURCE_DIR=" + str(source)], check=True)
        subprocess.run([str(cmake), "--build", str(build), "--target", "echo-decider", "-j", str(args.jobs)], check=True)
        built = list(build.rglob("libecho-decider.so"))
        if len(built) != 1:
            raise ValueError("Expected exactly one JNI artifact")
        copy_verified(built[0], native / "libecho-decider.so")
        stl = ndk / "toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so"
        copy_verified(stl, native / "libc++_shared.so")
    if not args.native_only and not args.skip_probe_build:
        build_probe(jdk, args.sdk, kotlin)
    manifest = {"schema_version": 1, "microphone_started": False, "phone_touched": False,
                "lock_sha256": digest(HERE / "android-local.lock.json"), "files": {}}
    for parent in (OUT / "jniLibs", OUT / "models", OUT / "samples"):
        for path in sorted(parent.rglob("*")):
            if path.is_file():
                manifest["files"][str(path.relative_to(OUT))] = {"bytes": path.stat().st_size, "sha256": digest(path)}
    if (OUT / "probe.jar").is_file():
        path = OUT / "probe.jar"
        manifest["files"]["probe.jar"] = {"bytes": path.stat().st_size, "sha256": digest(path)}
    (OUT / "bundle-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"output": str(OUT), "jni_libs": str(native), "model_bytes": sum(
        f["bytes"] for n, f in manifest["files"].items() if n.startswith("models/")),
        "native_only": args.native_only, "native_built": not args.skip_native_build,
        "probe_built": not args.native_only and not args.skip_probe_build,
        "phone_touched": False, "microphone_started": False}))


if __name__ == "__main__":
    main()
