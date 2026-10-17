"""Derive Habi expression frames from the user-supplied front artwork.

The original PNG stays untouched. Eyes are detected as the two white vertical
blobs, removed with row-wise interpolation of the surrounding body colour, then
re-drawn as open / glancing / closed / happy variants. Output is a small
transparent WebP set for the in-app avatar.

    python3 tools/habi-avatar.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'apps/studio/public/habi/character-front.png'
OUT = ROOT / 'apps/studio/public/habi'
WIDTH = 640

src = Image.open(SOURCE).convert('RGBA')
px = np.array(src).astype(np.float32)
alpha = px[..., 3]
white = (alpha > 200) & (px[..., 0] > 235) & (px[..., 1] > 225) & (px[..., 2] > 200)
# Only the eye band: ignores highlights elsewhere on the body.
band = np.zeros_like(white)
band[1000:1900, 800:1900] = True
eyes = white & band
mask = np.array(Image.fromarray((eyes * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(13))) > 0

base = px.copy()
for y in np.nonzero(mask.any(1))[0]:
    row = mask[y]
    x = 0
    while x < row.size:
        if not row[x]:
            x += 1
            continue
        start = x
        while x < row.size and row[x]:
            x += 1
        left, right = max(start - 4, 0), min(x + 3, row.size - 1)
        for c in range(3):
            base[y, start:x, c] = np.linspace(base[y, left, c], base[y, right, c], x - start)
# Soften the filled area vertically so row seams disappear.
filled = Image.fromarray(base.astype(np.uint8), 'RGBA')
blurred = np.array(filled.filter(ImageFilter.GaussianBlur(10))).astype(np.float32)
soft = np.array(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32)[..., None] / 255
base[..., :3] = base[..., :3] * (1 - soft) + blurred[..., :3] * soft
eyeless = Image.fromarray(base.astype(np.uint8), 'RGBA')

eye_layer = np.zeros_like(px)
eye_layer[eyes] = px[eyes]
eye_img = Image.fromarray(eye_layer.astype(np.uint8), 'RGBA')

ys, xs = np.nonzero(eyes)
split = (xs.min() + xs.max()) // 2
boxes = []
for side in (xs < split, xs >= split):
    boxes.append((xs[side].min(), ys[side].min(), xs[side].max(), ys[side].max()))


def finish(img: Image.Image, name: str):
    crop = img.crop((0, 205, src.width, 3258))
    h = round(crop.height * WIDTH / crop.width)
    crop.resize((WIDTH, h), Image.LANCZOS).save(OUT / f'{name}.webp', 'WEBP', quality=90, method=6)


def with_eyes(dx=0, dy=0):
    img = eyeless.copy()
    img.alpha_composite(eye_img, (dx, dy))
    return img


def drawn(kind: str):
    img = eyeless.copy()
    draw = ImageDraw.Draw(img)
    for x0, y0, x1, y1 in boxes:
        w = x1 - x0
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2 + (y1 - y0) * .12
        stroke = int(w * .3)
        if kind == 'closed':
            draw.rounded_rectangle((cx - w * .55, cy - stroke / 2, cx + w * .55, cy + stroke / 2), radius=stroke // 2, fill=(255, 255, 255, 255))
        else:  # happy: an upturned arc
            r = w * .62
            draw.arc((cx - r, cy - r * .55, cx + r, cy + r * 1.25), start=200, end=340, fill=(255, 255, 255, 255), width=stroke)
    return img


finish(src, 'habi-open')
finish(with_eyes(-70, 0), 'habi-look-l')
finish(with_eyes(70, 0), 'habi-look-r')
finish(with_eyes(0, -60), 'habi-look-up')
finish(drawn('closed'), 'habi-closed')
finish(drawn('happy'), 'habi-happy')
print('eye boxes', boxes)
