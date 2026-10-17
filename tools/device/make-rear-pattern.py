#!/usr/bin/env python3
"""Turn editable 17x23 dot drawings into a custom rear-screen pattern.

Use # for a lit pixel and . for an unlit pixel. Separate animation frames with
one blank line. This command does not connect to or change the phone.
"""
import argparse
import json
from pathlib import Path
import re


def make_pattern(text, scene="eating", pattern_id="habi-eating-v1", title="进食", duration_ms=900):
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", scene):
        raise ValueError("scene must use lowercase letters, digits or underscores")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", pattern_id):
        raise ValueError("pattern id must use lowercase letters, digits or hyphens")
    if not 120 <= duration_ms <= 10000:
        raise ValueError("frame duration must be between 120 and 10000 ms")
    groups = re.split(r"\n\s*\n", text.strip())
    if not 1 <= len(groups) <= 32:
        raise ValueError("provide between 1 and 32 frames")
    frames = []
    for index, group in enumerate(groups):
        rows = group.splitlines()
        if len(rows) != 23 or any(len(row) != 17 or set(row) - {".", "#"} for row in rows):
            raise ValueError(f"frame {index}: exactly 23 rows of 17 dots/hashes required")
        frames.append({
            "durationMs": duration_ms,
            "rows": rows,
            "rowBitmasks": [int(row.replace(".", "0").replace("#", "1"), 2) for row in rows],
        })
    return {
        "schemaVersion": 2, "brand": "Habi", "patternId": pattern_id,
        "title": title, "width": 17, "height": 23,
        "format": "row-bitmask-msb-left",
        "bitMeaning": "1=lit, 0=unlit; bit16=x0, bit0=x16",
        "status": "custom artwork; device submission and physical appearance require separate validation",
        "sceneAliases": {scene: scene},
        "scenes": {scene: {"loop": len(frames) > 1, "frames": frames}},
    }


def preview(pattern, directory):
    from PIL import Image, ImageDraw
    directory.mkdir(parents=True, exist_ok=True)
    scene = next(iter(pattern["scenes"]))
    frames = pattern["scenes"][scene]["frames"]
    images = []
    for frame in frames:
        cell, pad = 20, 24
        image = Image.new("RGB", (17 * cell + pad * 2, 23 * cell + pad * 2), (15, 19, 21))
        draw = ImageDraw.Draw(image)
        for y, row in enumerate(frame["rows"]):
            for x, value in enumerate(row):
                cx, cy, radius = pad + (x + .5) * cell, pad + (y + .5) * cell, 5.8
                draw.ellipse((cx-radius, cy-radius, cx+radius, cy+radius),
                             fill=(247, 247, 233) if value == "#" else (34, 39, 42))
        images.append(image)
    images[0].save(directory / f"{scene}-first-frame.png")
    if len(images) > 1:
        images[0].save(directory / f"{scene}-design-preview.gif", save_all=True,
                       append_images=images[1:], duration=[frame["durationMs"] for frame in frames], loop=0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="17x23 ASCII drawing(s)")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scene", default="eating")
    parser.add_argument("--pattern-id", default="habi-eating-v1")
    parser.add_argument("--title", default="进食")
    parser.add_argument("--duration-ms", type=int, default=900)
    parser.add_argument("--preview-dir", type=Path, help="Optional PNG/GIF previews; requires Pillow")
    args = parser.parse_args()
    try:
        pattern = make_pattern(args.input.read_text(), args.scene, args.pattern_id, args.title, args.duration_ms)
    except ValueError as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(pattern, ensure_ascii=False, indent=2) + "\n")
    if args.preview_dir:
        preview(pattern, args.preview_dir)
    print(f"Created {args.output}: {len(pattern['scenes'][args.scene]['frames'])} frame(s), 17x23")


if __name__ == "__main__":
    main()
