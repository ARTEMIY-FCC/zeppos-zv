# ZV format and how the decoder works

This document describes the `.zv` file (version `ZVV1`), the bitstream inside
it and the way the watch turns it into pictures. The reference implementations
are `encoder/zv.py` (`pack`, `parse`, `decode`) and `watch/lib/zv.js`; they are
bit-exact and `tools/zvtest.mjs` checks that.

## 1. The idea

Zepp OS has no video decoder, and JavaScript on the watch is slow per
operation (an interpreter on a microcontroller). What the platform does well:

- an `IMG` widget shows any PNG file from the app's data folder, decoded
  natively, and `auto_scale: true` stretches it to the widget size;
- writing a ~58 KB file is cheap, and so are native typed-array operations
  (`copyWithin`, `fill`, `Uint32Array` element stores).

ZV is designed around that:

1. The frame buffer on the watch is **the byte image of a PNG file**: a palette
   PNG whose image data is one *stored* (uncompressed) deflate block. Every
   buffer row is exactly a PNG scanline: the filter byte followed by the
   pixels' palette indices.
2. A frame of the stream says how to update that buffer, in units of 8×8 and
   4×4 blocks, so that most of the work is block copies and 32-bit stores
   rather than per-pixel JavaScript.
3. After updating, the watch writes `prefix + buffer + suffix` to a file with a
   single `writeSync` and sets it as the `IMG` source.
4. A PNG is only accepted with valid checksums (CRC32 of the `IDAT` chunk and
   Adler-32 of the zlib stream). Computing them on the watch would cost more
   than decoding the frame, so the **encoder computes them** — it runs exactly
   the same reconstruction — and stores the 8 bytes with every frame.

## 2. Frame geometry

- `S` — row stride in bytes, `H` — height. Defaults: `S = H = 240`.
- Byte 0 of every row is the PNG filter type and must be `0`; bytes `1..S-1`
  are visible pixels. The PNG is therefore `(S-1) × H` = **239 × 240**.
- `S` is a multiple of 8 (macroblocks) and of 4, so 4×4 blocks start at
  4-byte aligned addresses and a block row is one `Uint32` store.
- Blocks in the first block column also cover the filter byte and may write
  junk there; after every frame the decoder sets byte 0 of every row to 0.
  The encoder gives column 0 zero weight when choosing modes.
- One stored deflate block holds at most 65535 bytes: `S × H ≤ 65535`.

## 3. File layout

All integers are little-endian unless noted.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic `ZVV1` |
| 4 | 2 | `S` — row stride |
| 6 | 2 | `H` — height |
| 8 | 2 | frames per second × 100 |
| 10 | 2 | `N` — number of frames |
| 12 | 4 | audio offset (0 if there is no audio) |
| 16 | 4 | audio length |
| 20 | 4 | `data_at` — start of frame data (= header size) |
| 24 | 2 | `plen` — PNG prefix length |
| 26 | plen | PNG prefix |
| … | var | rANS tables, 14 contexts (see §5) |
| … | 4·(N+1) | frame offsets from the start of the file; `offs[N]` = end of the last frame |
| `data_at` | … | frames |
| audio offset | audio length | MP3 (MPEG-1 Layer III, 32 kHz mono) |

Everything before `data_at` is read once. A frame `i` is the byte range
`offs[i] .. offs[i+1]`:

| Size | Field |
| --- | --- |
| 4 | Adler-32 of the frame buffer, big-endian |
| 4 | CRC32 of the `IDAT` chunk, big-endian |
| 4 | initial rANS state, big-endian |
| … | rANS renormalisation bytes, read forward |

### PNG prefix and suffix

The prefix is a complete PNG head up to the image data:

```
89 50 4E 47 0D 0A 1A 0A                       signature
IHDR  width=S-1 height=H depth=8 colour type=3 (palette)
PLTE  256 × RGB
IDAT  length = 7 + S·H + 4
      78 01                                   zlib header
      01 LEN NLEN                             stored block, final; LEN = S·H (LE)
```

The decoder appends the suffix after the buffer:

```
Adler-32 (4) + CRC32 (4)                      the 8 bytes stored with the frame
00 00 00 00 49 45 4E 44 AE 42 60 82           IEND
```

So the PNG file is `prefix + buffer (S·H) + 8 checksum bytes + IEND`.

## 4. Frame bitstream

The decoder keeps two buffers: `prev` (the last frame) and `cur`. Before the
first frame both are all zeros. At the start of a frame `cur` equals `prev`;
motion copies read `prev` and write `cur`, everything else writes `cur`.

Macroblocks (8×8) are decoded in raster order. For each macroblock:

```
type = sym(ctx = mbt[2·leftSkip + topSkip])     alphabet 4
```

`leftSkip`/`topSkip` are 1 if the macroblock to the left/above is `SKIP` or
does not exist.

| type | name | data | operation |
| --- | --- | --- | --- |
| 0 | SKIP | — | nothing |
| 1 | MV | `v = sym(mv)` | copy 8×8 from `prev` at `(x+dx, y+dy)`, `dx = v % 15 − 7`, `dy = ⌊v / 15⌋ − 7` |
| 2 | FILL | `d = sym(fill)` | fill 8×8 with `c = (d + pred) & 255` |
| 3 | SPLIT | four 4×4 blocks | top-left, top-right, bottom-left, bottom-right |

`pred` is the palette index just left of the block's top-left byte in `cur`
(`cur[off − 1]`, where `off = y·S + x`), or 0 for the very first byte.

Each 4×4 block of a SPLIT:

```
type = sym(ctx = previous 4×4 block in this frame was SKIP ? sbt0 : sbt1)   alphabet 5
```

(the "previous 4×4 block" starts as SKIP at the beginning of every frame)

| type | name | data | operation |
| --- | --- | --- | --- |
| 0 | SKIP | — | nothing |
| 1 | MV | `v = sym(mv4)` | copy 4×4 from `prev` with the vector `v` (as above) |
| 2 | FILL | `d = sym(fill)` | `c = (d + pred) & 255` |
| 3 | PAT | `da = sym(pata)`, `db = sym(patb)`, `m0 = sym(mask0)`, `m1 = sym(mask1)` | `a = (da + pred) & 255`, `b = (db + a) & 255`, `mask = m0 \| m1 << 8`; pixel `(r, c)` is `b` if bit `4r + c` is set, else `a` |
| 4 | RAW | 16 × `sym(raw)` | `p = pred`; for each pixel in raster order `p = (sym + p) & 255` |

After all macroblocks: byte 0 of every row of `cur` is set to 0, the 8
checksum bytes go into the suffix, the file is written, and `cur` is copied
to `prev`.

The encoder never emits a motion vector that reads outside the frame.

## 5. Entropy coding (rANS)

Contexts, in order (index, alphabet size):

| # | name | alphabet | meaning |
| --- | --- | --- | --- |
| 0–3 | `mbt0..3` | 4 | macroblock type by neighbour context |
| 4, 5 | `sbt0`, `sbt1` | 5 | 4×4 block type by previous block |
| 6 | `mv` | 225 | macroblock motion vector |
| 7 | `mv4` | 225 | 4×4 motion vector |
| 8 | `fill` | 256 | fill colour − `pred` |
| 9 | `pata` | 256 | pattern colour A − `pred` |
| 10 | `patb` | 256 | colour B − colour A |
| 11, 12 | `mask0`, `mask1` | 256 | pattern mask, rows 0–1 and 2–3 |
| 13 | `raw` | 256 | pixel − previous pixel |

Table serialisation, per context: `u16 count`, then `count` entries of
`u8 symbol, u16 freq − 1`, symbols in increasing order. Frequencies of a
context sum to 4096; a context with no entries is never used.

Decoding (12-bit probabilities, `L = 2^23`, byte-wise renormalisation):

```
x = first 4 bytes, big-endian
sym(ctx):
    slot = x & 4095
    s    = the symbol with cum[s] ≤ slot < cum[s] + freq[s]
    x    = freq[s] · (x >> 12) + slot − cum[s]
    while x < 2^23: x = (x << 8) | next byte
    return s
```

The encoder (`rans_encode`) processes the symbols of a frame in reverse and
reverses its output, so the decoder reads forward. Every frame is an
independent rANS stream; the tables are shared by the whole file.

`watch/lib/zv.js` packs each slot into one `Uint32`:
`symbol | (freq − 1) << 8 | cum << 20`, filled with `TypedArray.fill` per
symbol (a per-slot loop takes seconds on the watch). One symbol then costs a
lookup and a few integer operations.

## 6. Decoder memory and speed

`createDecoder()` allocates one `ArrayBuffer`:

```
[ prev: S·H ][ pad ][ PNG prefix ][ cur: S·H ][ suffix: 20 ]
                                  ^ 4-byte aligned
```

For 240×240 that is ~117 KB, plus 229 KB of rANS tables (14 × 4096 × 4).
The whole file is never loaded: the player reads one frame at a time
(`readSync` with `position`). JavaScript on the watch has a heap of only a few
megabytes.

Per frame the decoder does one rANS step per symbol, 4–8 `copyWithin` calls per
motion block, 4–16 `Uint32` stores per fill/pattern block, 240 byte stores for
the filter column and one `copyWithin` of the whole buffer. In QuickJS on a
desktop CPU this is 0.7–0.9 ms per frame at 15 KB/s.

## 7. How the encoder chooses blocks

`encoder/zv.py`, class `Encoder`:

- **Colour space.** OKLab ×100 with lightness weighted 1.6 — brightness errors
  are more visible than colour errors.
- **Palette.** k-means (k-means++ seeding) over 50 000 sampled pixels of the
  whole clip, 256 colours, sorted by brightness bands and hue so that
  neighbouring indices are similar colours (colour differences to `pred` stay
  small and compress well).
- **Rate–distortion decision.** For every macroblock and 4×4 block the encoder
  evaluates `distortion + λ · bits` for every mode and keeps the cheapest. Bits
  come from the running symbol statistics.
- **Motion search.** Luma-only coarse search: all vectors up to ±3 at full
  resolution, even vectors up to ±6 on a half-size image; then the exact colour
  error for the 4 best vectors per block, plus a ±1 refinement around the best
  macroblock vector.
- **Two-colour patterns.** 2-means inside the block, then the best pair among
  the nearest palette colours; tried only where SKIP and MV are noticeably wrong.
- **Rate control** (`kbps`). λ follows the budget: every half second of
  overspend doubles it; a slow average also learns the clip's typical λ. The
  first frame and scene cuts get a smaller λ (more bits) because they are built
  from scratch.
- **Exactness.** The encoder reconstructs every frame exactly as the decoder
  will (`build`), computes the PNG checksums from that reconstruction and
  measures the next frame's error against it, so there is no drift.

## 8. Zepp OS notes

Facts this design relies on, found in the Zepp OS emulator (Balance 2, OS 5):

- `IMG` with `src: 'data://path.png'` shows PNG files the app wrote with
  `@zos/fs` — palette, RGB, compressed or stored. Checksums must be valid. The
  file extension does not matter. Plain TGA (types 1/2) and BMP are not loaded.
- `auto_scale: true` scales with nearest neighbour.
- **Images are cached by file name.** Rewriting a file and setting the same
  `src` again shows the old picture, so every frame gets its own name (the
  player uses `zvf/<clip>_<n>.png`; the content behind a name never changes).
- Swapping a full-screen scaled `IMG` source costs ~38 ms in the emulator;
  writing a 58 KB file ~4 ms.
- `canvas.drawImage` does not accept `data://` paths.
- An `IMG` widget gets no touch events; a transparent full-screen `BUTTON`
  does, and it does not block `onGesture`.
- The emulator runs JavaScript roughly 700× slower than QuickJS on a desktop;
  use `qjs` (`tools/zvbench.mjs`) to measure decoder changes.
