#!/usr/bin/env python3
"""Look at a .zv file: python3 zvpreview.py video.zv sheet.png

Decodes the file with the reference decoder (checksums included) and saves
eight evenly spaced frames, scaled 2x with nearest neighbour as on the watch.
"""
import sys

import numpy as np
from PIL import Image

import zv

if len(sys.argv) != 3:
    raise SystemExit(__doc__)
blob = open(sys.argv[1], "rb").read()
v, frames = zv.decode(blob)
# the palette is the PLTE chunk inside the PNG prefix: signature (8) + IHDR (25) + chunk header (8)
pal = np.frombuffer(v["prefix"][8 + 25 + 8:8 + 25 + 8 + 768], np.uint8).reshape(256, 3)
n = len(frames)
h, s = frames[0].shape
pick = list(range(0, n, max(1, n // 8)))[:8]
tiles = [Image.fromarray(pal[frames[i][:, 1:]]).resize(((s - 1) * 2, h * 2), Image.NEAREST) for i in pick]
w, th = tiles[0].size
sheet = Image.new("RGB", (w * 4, th * ((len(tiles) + 3) // 4)), (30, 30, 30))
for k, t in enumerate(tiles):
    sheet.paste(t, ((k % 4) * w, (k // 4) * th))
sheet.save(sys.argv[2])
print(f"{n} frames {s - 1}x{h} @ {v['fps']:g} fps, {len(blob)} bytes, audio {len(v['audio'])} bytes")
