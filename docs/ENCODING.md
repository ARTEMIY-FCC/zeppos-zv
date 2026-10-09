# Converting video to .zv

## Requirements

- Python 3.9 or newer with `numpy` (the encoder) and `Pillow` (previews only)
- `ffmpeg` in `PATH` (decoding the source, scaling, MP3 audio)

```bash
pip install numpy pillow
```

No GPU, no other libraries. Encoding a 10-second clip takes ~10–15 s on a
modern laptop core (an old server CPU needs ~1 minute).

## Command line

```bash
python3 encoder/zvcli.py INPUT OUTPUT.zv [options]
```

`INPUT` is anything ffmpeg can read: mp4, mov, webm, mkv, animated gif, a URL…

| Option | Default | Meaning |
| --- | --- | --- |
| `--sec S` | 10 | how many seconds to take |
| `--start S` | 0 | where to start, in seconds |
| `--fps F` | 12 | frame rate of the result |
| `--kbps K` | 15 | target **video** rate in kilobytes per second; `0` = constant quality (`--lam`) |
| `--lam L` | 30 | rate–distortion λ: the starting value for rate control, or the fixed value with `--kbps 0`; higher = smaller and blurrier |
| `--fit cover\|contain` | cover | `cover` crops the centre to fill the screen, `contain` letterboxes the whole picture |
| `--size N` | 240 | row stride and height (multiple of 8, `N·N ≤ 65535`); the picture is `(N−1)×N` |
| `--audio K` | 32 | MP3 bitrate in kbit/s; `0` = no sound |
| `--preview PNG` | — | save eight decoded frames scaled 2× as on the watch |

The tool prints the result and checks it with the reference decoder:

```
clip.mp4: 120 frames, video 162.8 KB (1.36 KB/frame, 16.3 KB/s), audio 39.4 KB, file 208.3 KB, error 3.61, 14 s
```

`error` is the mean colour error per pixel in the encoder's working space
(OKLab ×100, lightness ×1.6): around 2 looks very close to the source, 3–4 is
good, above 6 blockiness is visible in motion.

### Examples

```bash
# 10 s, default quality (~15 KB/s video + 4 KB/s audio)
python3 encoder/zvcli.py meme.mp4 meme.zv

# sharper, for text-heavy clips
python3 encoder/zvcli.py meme.mp4 meme.zv --kbps 26

# smallest: 10 fps, 9 KB/s video
python3 encoder/zvcli.py meme.mp4 meme.zv --fps 10 --kbps 9

# a 6-second part from 0:42, whole picture visible (letterbox), no sound
python3 encoder/zvcli.py movie.mkv part.zv --start 42 --sec 6 --fit contain --audio 0

# constant quality instead of a target rate
python3 encoder/zvcli.py clip.mp4 clip.zv --kbps 0 --lam 20
```

## Choosing settings

**Size budget.** The file travels phone → watch over Bluetooth, so its size is
what the user waits for. Presets used by the example server:

| Preset | fps | video | + audio | 10 s clip |
| --- | --- | --- | --- | --- |
| low | 10 | 9 KB/s | 4 KB/s | ~130 KB |
| mid | 12 | 15 KB/s | 4 KB/s | ~200 KB |
| high | 12 | 26 KB/s | 4 KB/s | ~330 KB |

The rate is a target, not a cap: static clips use less, the first frame and
scene cuts get extra bits and the following frames pay them back.

**Frame rate.** 12 fps is a good balance; 10 fps saves ~15 %. Above 15 fps the
watch spends more time swapping images than it gains.

**Cropping.** Most memes are vertical (9:16). `cover` crops the centre square
and fills a round screen; captions at the very top or bottom may be cut.
`contain` keeps everything but leaves black bars, and on a round screen the
corners are hidden anyway.

**What compresses well.** Static backgrounds, talking heads, captions on
plain backgrounds. **What does not:** a shaky hand-held camera, confetti,
water, film grain — everything changes every frame and the codec has no
residual coding, so it falls back to two-colour 4×4 patterns.

**Audio.** MPEG-1 Layer III at 32 kHz mono. Do not use MPEG-2 sample rates
(22.05/24 kHz): Zepp OS reports half the real duration for such files.

## Python API

```python
import zv  # encoder/zv.py

frames = zv.read_frames("in.mp4", vw=239, h=240, fps=12, seconds=10, fit="cover")  # (n, 240, 239, 3) uint8
audio = zv.read_audio_mp3("in.mp4", seconds=len(frames) / 12)                        # bytes, may be b""

enc = zv.Encoder(s=240, h=240, lam=30)
blob, recon, palette = enc.encode(frames, fps=12, audio=audio, kbps=15)
open("out.zv", "wb").write(blob)

info, decoded = zv.decode(blob)   # reference decoder, raises if a checksum does not match
```

`frames` can come from anywhere (rendered graphics, a game capture…) as long
as it is an `(n, H, S−1, 3)` `uint8` RGB array. `log=callback(i, n)` reports
progress. `recon` is the list of index buffers exactly as the watch will build
them; `palette` is `(256, 3)` RGB.

## Checking a file

```bash
python3 encoder/zvpreview.py out.zv sheet.png     # eight frames as on the watch
node tools/zvtest.mjs out.zv                      # watch decoder vs stored checksums
node tools/zvtest.mjs out.zv frame.png 30         # also save frame 30 as the exact PNG the watch writes
qjs --std tools/zvbench.mjs out.zv                # decoder speed in QuickJS (brew install quickjs)
```

## Getting the file onto the watch

- **In the app package:** put it in `assets/<target>/` (e.g. `assets/gt.r/`)
  and call `player.load('name.zv', true, 'name')`. `tools/make-demo.sh` does
  this for the example app's demo clip.
- **At runtime:** the phone side of a Zepp OS app cannot write files, only
  download a URL and transfer it (`transferFile`). Serve the `.zv` over HTTP,
  download it on the phone and enqueue it to the watch; it arrives in
  `data://download/<name>`, then `player.load('download/<name>', false, id)`.
  `watch/app-side/index.js` and `server/` show the complete flow.
