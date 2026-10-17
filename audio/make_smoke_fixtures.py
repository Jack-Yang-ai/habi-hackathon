#!/usr/bin/env python3
"""Generate silence and a quiet pure tone, never simulated eating or human audio."""

import argparse
from array import array
import math
from pathlib import Path
import sys
import wave

from audio.fetch_models import ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / ".tools/audio-validation/fixtures")
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    rate, seconds = 16000, 30
    for name in ("silence", "quiet_440hz_tone"):
        samples = array("h", (0 if name == "silence" else
                               round(0.03 * 32767 * math.sin(2 * math.pi * 440 * i / rate))
                               for i in range(rate * seconds)))
        if sys.byteorder != "little":
            samples.byteswap()
        path = args.directory / (name + ".wav")
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(samples.tobytes())
        print(path)


if __name__ == "__main__":
    main()
