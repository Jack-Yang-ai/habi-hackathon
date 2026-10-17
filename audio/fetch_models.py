#!/usr/bin/env python3
"""Fetch only the pinned official CPU/int8 artifacts; never downloads on import."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIRECTORY = ROOT / ".tools" / "audio-models"
LOCK = Path(__file__).with_name("models.lock.json")


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def matches(path, expected):
    return (path.is_file() and path.stat().st_size == expected["bytes"]
            and digest_file(path) == expected["sha256"])


def fetch_single_file(asset, destination):
    target = destination / asset["name"]
    if not matches(target, asset):
        partial = target.with_suffix(".partial")
        request = urllib.request.Request(
            asset["url"], headers={"User-Agent": "DE-Rebirth-audio-validation/0.1"})
        try:
            total = 0
            with urllib.request.urlopen(request, timeout=60) as src, partial.open("wb") as dst:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > asset["bytes"]:
                        raise ValueError("Download exceeds pinned byte count")
                    dst.write(chunk)
            if not matches(partial, asset):
                raise ValueError("Downloaded bytes/hash do not match models.lock.json")
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
    return target


def fetch_asset(asset, destination):
    archive = fetch_single_file(asset, destination)

    model_directory = destination / asset["directory"]
    wanted = asset["files"]
    if not all(matches(model_directory / name, info) for name, info in wanted.items()):
        # Never extract links, source code, unpinned files, or arbitrary archive paths.
        with tarfile.open(archive, "r:bz2") as source:
            members = {}
            for member in source.getmembers():
                parts = PurePosixPath(member.name).parts
                if len(parts) < 2 or parts[0] != asset["directory"]:
                    continue
                relative = PurePosixPath(*parts[1:])
                if ".." in relative.parts or relative.is_absolute():
                    raise ValueError("Unsafe path in model archive")
                name = str(relative)
                if name in wanted:
                    if not member.isfile() or member.size != wanted[name]["bytes"]:
                        raise ValueError("Unexpected archive member type or size")
                    members[name] = member
            if set(members) != set(wanted):
                raise ValueError("Model archive is missing pinned files")
            for name, member in members.items():
                target = model_directory / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                if not matches(target, wanted[name]):
                    target.unlink(missing_ok=True)
                    raise ValueError("Extracted model file hash does not match lock")
    return model_directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY)
    parser.add_argument("--model", choices=("all", "sensevoice_int8", "zipformer_audio_tagging_int8", "silero_vad"), default="all")
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    lock = json.loads(LOCK.read_text())
    for asset in lock["assets"]:
        if args.model in ("all", asset["id"]):
            print(json.dumps({"model": asset["id"], "directory": str(fetch_asset(asset, args.directory)),
                              "verified_sha256": asset["sha256"]}))
    for asset in lock.get("single_files", []):
        if args.model in ("all", asset["id"]):
            print(json.dumps({"model": asset["id"], "path": str(fetch_single_file(asset, args.directory)),
                              "verified_sha256": asset["sha256"]}))


if __name__ == "__main__":
    main()
