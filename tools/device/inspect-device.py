#!/usr/bin/env python3
"""Read-only device evidence collector. Raw output is local and ignored by Git."""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
COMMANDS = {
    "devices": ["devices", "-l"],
    "properties": ["shell", "getprop"],
    "identity": ["shell", "id"],
    "root_identity": ["shell", "su -c id"],
    "display": ["shell", "dumpsys display"],
    "back_screen": ["shell", "dumpsys display_ext back_screen"],
    "back_screen_help": ["shell", "dumpsys display_ext back_screen help"],
    "services": ["shell", "service list"],
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", default=str(ROOT / ".tools/platform-tools/adb"))
    parser.add_argument("--serial")
    parser.add_argument("--output", default=str(ROOT / ".tools/device-diagnostics"))
    args = parser.parse_args()
    base = [args.adb] + (["-s", args.serial] if args.serial else [])
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    summary = {}
    for name, command in COMMANDS.items():
        try:
            p = subprocess.run(base + command, capture_output=True, text=True, timeout=8)
            (output / (name + ".txt")).write_text(p.stdout + p.stderr)
            summary[name] = {"exit_code": p.returncode, "file": name + ".txt"}
        except subprocess.TimeoutExpired:
            summary[name] = {"error": "timeout_after_8_seconds"}
    (output / "index.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
