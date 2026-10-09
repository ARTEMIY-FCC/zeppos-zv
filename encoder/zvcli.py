#!/usr/bin/env python3
"""Convert a video into .zv for Zepp OS watches and report what the watch will get.

    python3 zvcli.py input.mp4 output.zv [--sec 10] [--fps 12] [--kbps 15] [--preview sheet.png]

Any input ffmpeg can read works (mp4, webm, mov, gif, ...). See docs/ENCODING.md.
"""
import argparse
import time

import numpy as np
from PIL import Image

import zv


def contact(recon, pal, path, cols=4):
    """Eight evenly spaced frames, scaled 2x with nearest neighbour as on the watch."""
    n = len(recon)
    pick = list(range(0, n, max(1, n // 8)))[:8]
    h, s = recon[0].shape
    tiles = [Image.fromarray(pal[recon[i][:, 1:]]).resize(((s - 1) * 2, h * 2), Image.NEAREST) for i in pick]
    w, th = tiles[0].size
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (w * cols, th * rows), (30, 30, 30))
    for k, t in enumerate(tiles):
        sheet.paste(t, ((k % cols) * w, (k // cols) * th))
    sheet.save(path)


def main():
    ap = argparse.ArgumentParser(description="Convert a video into the ZV format for Zepp OS watches.")
    ap.add_argument("src", help="input video (anything ffmpeg can read)")
    ap.add_argument("out", help="output .zv file")
    ap.add_argument("--sec", type=float, default=10, help="seconds to take (default 10)")
    ap.add_argument("--start", type=float, default=0, help="start offset in seconds (default 0)")
    ap.add_argument("--fps", type=float, default=12, help="frames per second (default 12)")
    ap.add_argument("--kbps", type=float, default=15,
                    help="target video rate in kilobytes/s (default 15); 0 = constant quality (--lam)")
    ap.add_argument("--lam", type=float, default=30,
                    help="rate-distortion lambda: start value, or the fixed one with --kbps 0 "
                         "(higher = smaller and blurrier)")
    ap.add_argument("--size", type=int, default=240,
                    help="row stride = height, a multiple of 8 with size*size <= 65535 (default 240 -> 239x240 picture)")
    ap.add_argument("--fit", choices=["cover", "contain"], default="cover",
                    help="cover = crop to fill the screen (default), contain = letterbox")
    ap.add_argument("--audio", type=int, default=32, help="mp3 bitrate in kbit/s, 0 = no sound (default 32)")
    ap.add_argument("--preview", metavar="PNG", help="save a contact sheet of decoded frames")
    a = ap.parse_args()

    t0 = time.time()
    frames = zv.read_frames(a.src, a.size - 1, a.size, a.fps, a.sec, a.fit, start=a.start)
    if len(frames) < 1:
        raise SystemExit("no frames decoded — is the input a video?")
    audio = zv.read_audio_mp3(a.src, len(frames) / a.fps, start=a.start, kbps=a.audio) if a.audio else b""
    enc = zv.Encoder(a.size, a.size, lam=a.lam)
    blob, recon, pal = enc.encode(frames, a.fps, audio, kbps=a.kbps or None)
    with open(a.out, "wb") as f:
        f.write(blob)
    t1 = time.time()

    # decode back with the reference decoder: it verifies the PNG checksums of every frame
    v, dec = zv.decode(blob)
    assert all((x == y).all() for x, y in zip(dec, recon))
    vid = v["offs"][-1] - v["offs"][0]
    # quality: mean error in the working space (OKLab x100, luma weighted) against the source
    work = zv.srgb_to_work(frames)
    P = zv.srgb_to_work(pal)
    err = np.mean([np.sqrt(((P[r[:, 1:]] - w) ** 2).sum(-1)).mean() for r, w in zip(recon, work)])
    dur = len(frames) / a.fps
    print(f"{a.src.split('/')[-1]}: {len(frames)} frames, video {vid / 1024:.1f} KB "
          f"({vid / len(frames) / 1024:.2f} KB/frame, {vid / dur / 1024:.1f} KB/s), "
          f"audio {len(audio) / 1024:.1f} KB, file {len(blob) / 1024:.1f} KB, error {err:.2f}, {t1 - t0:.0f} s")
    if a.preview:
        contact(recon, pal, a.preview)


if __name__ == "__main__":
    main()
