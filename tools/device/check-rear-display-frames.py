#!/usr/bin/env python3
"""Validate the single Habi frame source and its documentation export."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'contracts/rear-display/habi.json'
EXPORT = ROOT / 'docs/studio/rear-display-frames.json'

def validate(pattern):
    assert pattern['brand'] == 'Habi'
    width, height = pattern['width'], pattern['height']
    assert (width, height) == (17, 23)
    assert pattern['format'] == 'row-bitmask-msb-left'
    assert {'idle', 'collecting', 'resting', 'watering', 'listening'} <= pattern['scenes'].keys()
    assert set(pattern['sceneAliases'].values()) <= pattern['scenes'].keys()
    assert not pattern['scenes']['resting']['loop'] and len(pattern['scenes']['resting']['frames']) == 1
    assert not pattern['scenes']['received']['loop'], 'Photo receipt must be a single animation, not a loop'
    count = 0
    for name, sequence in pattern['scenes'].items():
        assert isinstance(sequence['loop'], bool) and sequence['frames'], name
        for frame in sequence['frames']:
            count += 1
            rows, masks = frame['rows'], frame['rowBitmasks']
            assert len(rows) == len(masks) == height, name
            assert 120 <= frame['durationMs'] <= 10000, name
            for y, row in enumerate(rows):
                assert len(row) == width and set(row) <= {'.', '#'}, (name, y)
                expected = sum(1 << (width - 1 - x) for x, value in enumerate(row) if value == '#')
                assert masks[y] == expected, (name, y, 'bit order or export mismatch')
            assert masks[0] == masks[-1] == 0, name
            assert all(not (row & ((1 << (width - 1)) | 1)) for row in masks), name
            blocks = [(x, y) for y in range(6, 13) for x in range(3, 13)
                      if all(rows[y + dy][x + dx] == '#' for dy in range(3) for dx in range(2))]
            assert any(x2 - x1 >= 4 and y1 == y2 for x1, y1 in blocks for x2, y2 in blocks), (name, 'missing white eyes')
    return count

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export', action='store_true', help='Refresh the documentation export after validation')
    args = parser.parse_args()
    pattern = json.loads(SOURCE.read_text())
    count = validate(pattern)
    if args.export:
        EXPORT.write_text(json.dumps(pattern, ensure_ascii=False, indent=2) + '\n')
    assert json.loads(EXPORT.read_text()) == pattern, 'Documentation export differs; run with --export'
    web = (ROOT / 'apps/studio/src/RearDisplay.tsx').read_text()
    native = (ROOT / 'android/app/src/main/java/com/withecho/companion/RearDisplayController.kt').read_text()
    gradle = (ROOT / 'android/app/build.gradle.kts').read_text()
    assert '../../../contracts/rear-display/habi.json' in web
    assert 'assets.open("habi.json")' in native
    assert 'assets.srcDir("../../contracts/rear-display")' in gradle
    print(f'Habi frames verified: {len(pattern["scenes"])} scenes, {count} frames; web, Android and export use the same source.')

if __name__ == '__main__':
    main()
