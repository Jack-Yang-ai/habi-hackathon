#!/usr/bin/env python3
"""Install/verify pinned Decider source, Q4 model and isolated runtime; no server start."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCK = Path(__file__).with_name("decider-model.lock.json")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def ensure_model_file(directory, name, info, verify_only):
    path = directory / name
    if path.exists():
        if path.stat().st_size != info["bytes"] or digest(path) != info["sha256"]:
            raise ValueError(f"Existing {name} differs from the pinned release; preserve it and choose a different directory")
        return
    if verify_only:
        raise FileNotFoundError(f"Missing pinned model file: {name}")
    partial = path.with_suffix(path.suffix + ".partial")
    try:
        total = 0
        with urllib.request.urlopen(info["url"], timeout=60) as source, partial.open("wb") as target:
            while True:
                block = source.read(4 * 1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > info["bytes"]:
                    raise ValueError("Model download exceeds pinned size")
                target.write(block)
        if partial.stat().st_size != info["bytes"] or digest(partial) != info["sha256"]:
            raise ValueError(f"Downloaded {name} does not match the pinned release")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / ".tools/decider")
    parser.add_argument("--model-directory", type=Path, default=ROOT / ".tools/decider-08b-gguf")
    parser.add_argument("--venv", type=Path, default=ROOT / ".tools/decider-venv")
    parser.add_argument("--build-backend", choices=("cpu", "metal"), default="cpu")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text())

    def run(command, **kwargs):
        return subprocess.run(list(map(str, command)), cwd=ROOT, check=True, **kwargs)

    if not args.source.exists():
        if args.verify_only:
            parser.error("Pinned source checkout is missing")
        args.source.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--filter=blob:none", "--no-checkout", lock["source"]["repository"], args.source])
        run(["git", "-C", args.source, "checkout", "--detach", lock["source"]["commit"]])
    revision = subprocess.check_output(["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True).strip()
    if revision != lock["source"]["commit"]:
        parser.error("Existing source differs from the pinned commit; it was not reset")
    if subprocess.run(["git", "-C", str(args.source), "diff", "--quiet", "HEAD", "--", "decider"]).returncode:
        parser.error("Pinned source has local code changes; they were not reset")
    args.model_directory.mkdir(parents=True, exist_ok=True)
    for name, info in lock["model"]["files"].items():
        ensure_model_file(args.model_directory, name, info, args.verify_only)

    python = args.venv / "bin/python"
    if not args.verify_only:
        if not shutil.which("uv"):
            parser.error("uv is required to install the isolated Python 3.12 runtime")
        if not python.is_file():
            run(["uv", "venv", "--python", "3.12", args.venv])
        build_env = dict(os.environ, CMAKE_ARGS=("-DGGML_METAL=ON" if args.build_backend == "metal" else "-DGGML_METAL=OFF") + " -DGGML_NATIVE=OFF")
        run(["uv", "pip", "install", "--python", python, "-r", Path(__file__).with_name("requirements-decider.txt")], env=build_env)
        if args.build_backend == "metal":
            supported = subprocess.check_output([str(python), "-c", "import llama_cpp; print(int(llama_cpp.llama_supports_gpu_offload()))"], text=True).strip()
            if supported != "1":
                run(["uv", "pip", "install", "--python", python, "--reinstall-package", "llama-cpp-python",
                     "--no-binary", "llama-cpp-python", "llama-cpp-python==0.3.36"], env=build_env)
    if not python.is_file():
        parser.error("Isolated runtime is missing")
    check = """import importlib.metadata as m, json, llama_cpp, sys
expected={'torch':'2.8.0','transformers':'5.19.0','llama-cpp-python':'0.3.36','numpy':'2.5.4','huggingface-hub':'2.2.0','safetensors':'0.8.0','Jinja2':'3.1.6'}
actual={k:m.version(k) for k in expected}
assert all(actual[k]==v for k,v in expected.items()), actual
assert sys.version_info[:2]==(3,12), sys.version
print(json.dumps({'runtime':actual,'gpu_offload_build_support':bool(llama_cpp.llama_supports_gpu_offload())}))
"""
    result = subprocess.check_output([str(python), "-c", check], text=True)
    print(json.dumps({"verified": True, "source_commit": revision,
                      "model_sha256": lock["model"]["files"][lock["model"]["filename"]]["sha256"],
                      **json.loads(result), "server_started": False, "production_backend_modified": False}))


if __name__ == "__main__":
    main()
