#!/usr/bin/env python
"""Generate a seamless, tileable misty fog texture for Foundry's Fog Overlay.

Pure-PIL (no numpy). Multi-octave value noise, blurred with 3x3 wrap so the
edges tile, blended into soft cool-white wisps with a noise-driven alpha so the
fog reads as drifting mist rather than a flat sheet.

Run:  python generate_fog.py    ->  writes fog-overlay.png next to this script.
"""
import os
import random
from PIL import Image, ImageFilter, ImageOps

SIZE = 512
random.seed(7)


def tileable_noise(res, blur):
    """A SIZExSIZE grayscale octave that tiles seamlessly."""
    base = Image.new("L", (res, res))
    base.putdata([random.randint(0, 255) for _ in range(res * res)])
    # Tile 3x3 so a blur near the edges samples the wrapped neighbours.
    big = Image.new("L", (res * 3, res * 3))
    for i in range(3):
        for j in range(3):
            big.paste(base, (i * res, j * res))
    big = big.filter(ImageFilter.GaussianBlur(blur))
    center = big.crop((res, res, res * 2, res * 2))
    return center.resize((SIZE, SIZE), Image.BICUBIC)


# Large soft masses + medium body + fine wisps.
o1 = tileable_noise(12, 7)
o2 = tileable_noise(28, 5)
o3 = tileable_noise(56, 3)
img = Image.blend(o1, o2, 0.5)
img = Image.blend(img, o3, 0.30)
# Stretch to the full range (averaging octaves compresses it), then a gamma
# curve carves real clear gaps so it reads as wisps, not a flat sheet.
img = ImageOps.autocontrast(img, cutoff=1)
img = img.point(lambda p: int(255 * (p / 255) ** 1.8))
img = img.filter(ImageFilter.GaussianBlur(1.5))  # soften gamma contour banding

rgba = Image.new("RGBA", (SIZE, SIZE))
src, dst = img.load(), rgba.load()
for y in range(SIZE):
    for x in range(SIZE):
        v = src[x, y]
        # Soft cool-white mist; alpha follows density and tops out translucent.
        dst[x, y] = (210, 219, 232, int(v * 0.80))

out_path = os.path.join(os.path.dirname(__file__), "fog-overlay.png")
rgba.save(out_path)
print("saved", out_path)
