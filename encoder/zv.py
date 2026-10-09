"""
ZV — video for Zepp OS watches (encoder and reference decoder).

The watch can display a PNG from its own data folder and scale it (IMG +
auto_scale), but it cannot decode a properly compressed video, and a PNG per
frame would weigh ~28 KB. So a custom stream goes over Bluetooth and the watch
rebuilds an *uncompressed* PNG (deflate "stored" block) from it for the system
image loader.

The frame buffer on the watch is literally the PNG bytes: rows of S bytes,
byte 0 of each row is the PNG filter type (always 0), then S-1 visible pixels
(palette indices). S is a multiple of 4, so 4x4 blocks in buffer columns are
aligned for Uint32Array stores. Blocks in the first column also write junk
into the filter byte — the watch zeroes it after every frame, and so does the
encoder.

A frame is a grid of 8x8 macroblocks in raster order. Macroblock types:
  SKIP   — same as the previous frame;
  MV     — copy 8x8 from the previous frame with an offset (dx, dy);
  FILL   — fill with one colour;
  SPLIT  — four 4x4 blocks, each with its own type:
           SKIP / MV / FILL / PAT (two colours + 16-bit mask) / RAW (16 colours).
Copies only read the previous frame, so block order does not change the
result (except colour prediction, which reads the already decoded left pixel).

Symbols are coded with rANS (12-bit probabilities, byte-wise renormalisation)
using static per-video tables. PNG checksums (Adler-32 and CRC32) are computed
by the encoder — the watch has no time for that, it just copies 8 bytes.
"""
import struct
import subprocess
import zlib

import numpy as np

MAGIC = b"ZVV1"

# macroblock and 4x4 block types
MB_SKIP, MB_MV, MB_FILL, MB_SPLIT = range(4)
SB_SKIP, SB_MV, SB_FILL, SB_PAT, SB_RAW = range(5)

R = 7  # motion vector range, ±R
NMV = 2 * R + 1

# rANS contexts: (name, alphabet size)
CTX = [
    ("mbt0", 4), ("mbt1", 4), ("mbt2", 4), ("mbt3", 4),  # MB type by neighbours (left/top skipped?)
    ("sbt0", 5), ("sbt1", 5),                            # 4x4 type: previous block skipped / not
    ("mv", NMV * NMV),                                   # MB vector: (dy+R)*NMV + dx+R
    ("mv4", NMV * NMV),                                  # 4x4 block vector
    ("fill", 256),                                       # fill colour − left pixel
    ("pata", 256),                                       # pattern colour A − left pixel
    ("patb", 256),                                       # colour B − colour A
    ("mask0", 256), ("mask1", 256),                      # pattern mask: rows 0–1, 2–3
    ("raw", 256),                                        # pixel − previous pixel
]
CI = {name: i for i, (name, _) in enumerate(CTX)}

PROB_BITS = 12
PROB_SCALE = 1 << PROB_BITS
RANS_L = 1 << 23


# ───────────────────────────── colour ─────────────────────────────

LUMA_W = 1.6  # brightness matters more than colour: errors in L weigh more


def srgb_to_work(rgb):
    """sRGB (uint8, …×3) → working space: OKLab×100 with L multiplied by LUMA_W."""
    c = rgb.astype(np.float32) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                   [0.2119034982, 0.6806995451, 0.1073969566],
                   [0.0883024619, 0.2817188376, 0.6299787005]], np.float32)
    lms = np.cbrt(lin @ m1.T)
    m2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                   [1.9779984951, -2.4285922050, 0.4505937099],
                   [0.0259040371, 0.7827717662, -0.8086757660]], np.float32)
    lab = (lms @ m2.T) * 100.0
    lab[..., 0] *= LUMA_W
    return lab.astype(np.float32)


def work_to_srgb(w):
    lab = w.astype(np.float64).copy()
    lab[..., 0] /= LUMA_W
    lab /= 100.0
    m2i = np.array([[1.0, 0.3963377774, 0.2158037573],
                    [1.0, -0.1055613458, -0.0638541728],
                    [1.0, -0.0894841775, -1.2914855480]])
    lms = (lab @ m2i.T) ** 3
    m1i = np.array([[4.0767416621, -3.3077115913, 0.2309699292],
                    [-1.2684380046, 2.6097574011, -0.3413193965],
                    [-0.0041960863, -0.7034186147, 1.7076147010]])
    lin = np.clip(lms @ m1i.T, 0, 1)
    c = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.clip(np.round(c * 255), 0, 255).astype(np.uint8)


# ───────────────────────────── source ─────────────────────────────

def read_frames(path, vw, h, fps, seconds, fit="cover", start=0.0):
    """Video frames vw×h (uint8 RGB). cover — crop to fill, contain — letterbox."""
    # light sharpening after downscaling keeps small captions readable.
    # Crop in RGB: in yuv420p ffmpeg rounds an odd width down
    sharp = "unsharp=5:5:0.6:5:5:0.0,format=rgb24"
    if fit == "cover":
        sc = f"scale={vw}:{h}:force_original_aspect_ratio=increase:flags=lanczos,{sharp},crop={vw}:{h}"
    else:
        sc = (f"scale={vw}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,{sharp},"
              f"pad={vw}:{h}:(ow-iw)/2:(oh-ih)/2:black")
    vf = f"fps={fps},{sc}"
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(seconds), "-i", path,
           "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, vw, 3)


def read_audio_mp3(path, seconds, start=0.0, kbps=32):
    """Audio for the watch: MPEG-1 Layer III, 32 kHz mono (the watch reports MPEG-2 files as half as long)."""
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-t", str(seconds), "-i", path, "-vn",
           "-ac", "1", "-ar", "32000", "-b:a", f"{kbps}k", "-f", "mp3", "-"]
    r = subprocess.run(cmd, capture_output=True)
    return r.stdout if r.returncode == 0 else b""


# ───────────────────────────── palette ─────────────────────────────

def kmeans(x, k, iters=16, seed=0):
    """Plain k-means (k-means++ seeding) — no sklearn, keeps the server image small."""
    rng = np.random.default_rng(seed)
    x = x.astype(np.float32)
    x2 = (x ** 2).sum(1)
    c = np.empty((k, x.shape[1]), np.float32)
    c[0] = x[rng.integers(len(x))]
    d = ((x - c[0]) ** 2).sum(1)
    for i in range(1, k):
        p = d / d.sum() if d.sum() > 0 else None
        c[i] = x[rng.choice(len(x), p=p)]
        d = np.minimum(d, ((x - c[i]) ** 2).sum(1))
    for _ in range(iters):
        lab = (x2[:, None] - 2 * x @ c.T + (c ** 2).sum(1)[None]).argmin(1)
        cnt = np.bincount(lab, minlength=k).astype(np.float32)
        sums = np.zeros_like(c)
        np.add.at(sums, lab, x)
        empty = cnt == 0
        c[~empty] = sums[~empty] / cnt[~empty, None]
        if empty.any():  # empty centre — move it to the worst described point
            far = (x2 - 2 * (x * c[lab]).sum(1) + (c[lab] ** 2).sum(1)).argsort()[-empty.sum():]
            c[empty] = x[far]
    return c


def make_palette(frames_work, n=256, seed=0):
    """k-means over pixels of all frames (in working space) → palette."""
    px = frames_work.reshape(-1, 3)
    rng = np.random.default_rng(seed)
    take = min(len(px), 50000)
    sample = px[rng.choice(len(px), take, replace=False)]
    k = min(n, len(np.unique(np.round(sample * 4), axis=0)))
    cent = kmeans(sample, k, seed=seed)
    rgb = work_to_srgb(cent)
    if k < n:
        rgb = np.concatenate([rgb, np.zeros((n - k, 3), np.uint8)])
    work = srgb_to_work(rgb)
    # order: brightness bands, hue inside a band (snake order). Neighbouring
    # indices are then similar colours, so differences to a neighbour stay small
    L = work[:, 0]
    hue = np.arctan2(work[:, 2], work[:, 1])
    band = np.minimum((L / (L.max() + 1e-6) * 16).astype(int), 15)
    key = band * 10.0 + np.where(band % 2 == 0, hue, -hue)
    order = np.argsort(key, kind="stable")
    return rgb[order], work[order]


# ───────────────────────────── PNG ─────────────────────────────

def _chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


def png_parts(s, h, pal_rgb):
    """PNG head and tail around the raw rows (s*h bytes): one stored deflate block."""
    raw_len = s * h
    assert raw_len <= 65535, "a single stored deflate block holds at most 65535 bytes"
    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", s - 1, h, 8, 3, 0, 0, 0))
    plte = _chunk(b"PLTE", pal_rgb.astype(np.uint8).tobytes())
    zhead = b"\x78\x01" + b"\x01" + struct.pack("<HH", raw_len, raw_len ^ 0xFFFF)
    idat_len = len(zhead) + raw_len + 4
    prefix = b"\x89PNG\r\n\x1a\n" + ihdr + plte + struct.pack(">I", idat_len) + b"IDAT" + zhead
    suffix = b"\x00" * 8 + _chunk(b"IEND", b"")
    return prefix, suffix, zhead


def frame_sums(zhead, raw):
    """Adler-32 of the raw rows and CRC32 of the IDAT chunk — the 8 bytes the watch copies into the tail."""
    adler = zlib.adler32(raw) & 0xFFFFFFFF
    crc = zlib.crc32(b"IDAT" + zhead + raw + struct.pack(">I", adler)) & 0xFFFFFFFF
    return struct.pack(">II", adler, crc)


def png_file(prefix, suffix, raw, sums):
    return prefix + raw + sums + suffix[8:]


# ───────────────────────────── rANS ─────────────────────────────

def normalize_freqs(counts):
    """Counts → frequencies summing to PROB_SCALE; every seen symbol gets at least 1."""
    counts = np.asarray(counts, np.float64)
    used = counts > 0
    if used.sum() == 0:
        f = np.zeros(len(counts), np.int64)
        f[0] = PROB_SCALE
        return f
    f = np.zeros(len(counts), np.int64)
    f[used] = np.maximum(1, np.floor(counts[used] / counts.sum() * PROB_SCALE)).astype(np.int64)
    # fix up the sum by taking from / giving to the most frequent symbols
    diff = PROB_SCALE - f.sum()
    order = np.argsort(-counts)
    i = 0
    while diff != 0:
        s = order[i % used.sum()]
        if diff > 0:
            f[s] += 1
            diff -= 1
        elif f[s] > 1:
            f[s] -= 1
            diff += 1
        i += 1
    return f


class Tables:
    def __init__(self, freqs):
        self.freq = [np.asarray(f, np.int64) for f in freqs]
        self.cum = [np.concatenate([[0], np.cumsum(f)[:-1]]) for f in self.freq]

    def serialize(self):
        """Per context: u16 count of used symbols, then (u8 symbol, u16 freq−1) pairs."""
        out = bytearray()
        for f in self.freq:
            nz = np.nonzero(f)[0]
            out += struct.pack("<H", len(nz))
            for s in nz:
                out += struct.pack("<BH", int(s), int(f[s]) - 1)
        return bytes(out)

    @staticmethod
    def parse(buf, pos):
        freqs = []
        for _, a in CTX:
            (n,) = struct.unpack_from("<H", buf, pos)
            pos += 2
            f = np.zeros(a, np.int64)
            for _ in range(n):
                s, v = struct.unpack_from("<BH", buf, pos)
                pos += 3
                f[s] = v + 1
            freqs.append(f)
        return Tables(freqs), pos


def rans_encode(symbols, tables):
    """symbols — list of (context, symbol) in decoding order. Encoded backwards."""
    x = RANS_L
    out = bytearray()
    for ctx, s in reversed(symbols):
        f = int(tables.freq[ctx][s])
        c = int(tables.cum[ctx][s])
        assert f > 0, (CTX[ctx][0], s)
        x_max = ((RANS_L >> PROB_BITS) << 8) * f
        while x >= x_max:
            out.append(x & 0xFF)
            x >>= 8
        x = ((x // f) << PROB_BITS) + (x % f) + c
    out += struct.pack("<I", x)  # reversed below: the stream starts with the state, big-endian
    out.reverse()
    return bytes(out)


class RansDecoder:
    def __init__(self, data, tables):
        self.d = data
        self.t = tables
        self.p = 4
        self.x = struct.unpack_from(">I", data, 0)[0]
        self.slot = []
        for f, c in zip(tables.freq, tables.cum):
            sl = np.zeros(PROB_SCALE, np.int64)
            for s in np.nonzero(f)[0]:
                sl[c[s]:c[s] + f[s]] = s
            self.slot.append(sl)

    def get(self, ctx):
        m = self.x & (PROB_SCALE - 1)
        s = int(self.slot[ctx][m])
        self.x = int(self.t.freq[ctx][s]) * (self.x >> PROB_BITS) + m - int(self.t.cum[ctx][s])
        while self.x < RANS_L:
            self.x = (self.x << 8) | self.d[self.p]
            self.p += 1
        return s


# ───────────────────────────── encoder ─────────────────────────────

class Stats:
    """Symbol counts per context → bit cost estimates for mode decisions."""

    def __init__(self):
        self.c = [np.ones(a, np.float64) * 0.5 for _, a in CTX]
        # sensible priors: there are many skips
        for i in range(4):
            self.c[CI[f"mbt{i}"]][:] = [40, 4, 4, 8]
        self.c[CI["sbt0"]][:] = [20, 3, 6, 8, 1]
        self.c[CI["sbt1"]][:] = [10, 3, 6, 8, 1]
        for n in ("mv", "mv4"):
            self.c[CI[n]][R * NMV + R] = 0.1  # a zero vector is coded as SKIP

    def add(self, symbols):
        for ctx, s in symbols:
            self.c[ctx][s] += 1

    def bits(self, name):
        c = self.c[CI[name]]
        return -np.log2(c / c.sum())

    def cost(self, symbols):
        """Bits the symbols would take with the current statistics."""
        t = 0.0
        for ctx, s in symbols:
            c = self.c[ctx]
            t -= np.log2(c[s] / c.sum())
        return t

    def avg_bits(self, name):
        c = self.c[CI[name]]
        p = c / c.sum()
        return float(-(p * np.log2(p)).sum())


class Encoder:
    def __init__(self, s=240, h=240, lam=30.0, intra=0.3):
        assert s % 8 == 0 and h % 8 == 0
        self.s, self.h = s, h
        self.lam = lam
        self.intra = intra
        self.wcol = np.ones(s, np.float32)
        self.wcol[0] = 0.0  # column 0 is the PNG filter byte, it is not visible

    # ── mode decision for one frame ──
    def decide(self, prev, src, P, st, lam):
        s, h = self.s, self.h
        mbw, mbh = s // 8, h // 8
        sbw, sbh = s // 4, h // 4
        w = self.wcol[None, :]
        Pp = P[prev]  # (h, s, 3) — what is on screen now

        def blocksum(e, b):
            return e.reshape(h // b, b, s // b, b).sum((1, 3))

        # Motion search. First a coarse pass on luma only: near vectors (up to ±3)
        # at full resolution, far ones (even, up to ±6) on a half-size image.
        # Then the exact colour error for a few best vectors per block (exact()).
        # Borders are padded with NaN: a block reading outside the frame is never
        # chosen (NaN is not less than anything) — even in invisible column 0.
        Ppad = np.pad(Pp, ((R, R), (R, R), (0, 0)), constant_values=np.nan)
        Lpad = Ppad[..., 0]
        Ls = src[..., 0]
        bmv = st.bits("mv")
        bmv4 = st.bits("mv4")
        NEAR = 3
        near = [(dy, dx) for dy in range(-NEAR, NEAR + 1) for dx in range(-NEAR, NEAR + 1) if dy or dx]
        sbl = np.empty((len(near), sbh, sbw), np.float32)
        for j, (dy, dx) in enumerate(near):
            dl = Lpad[R + dy:R + dy + h, R + dx:R + dx + s] - Ls
            dl *= dl
            dl *= w
            sbl[j] = blocksum(dl, 4)
        # half size: a 4x4 block becomes 2x2, an 8x8 macroblock 4x4
        r2 = 3
        L2 = np.pad(Pp[..., 0].reshape(h // 2, 2, s // 2, 2).mean((1, 3)), r2, constant_values=np.nan)
        Ls2 = Ls.reshape(h // 2, 2, s // 2, 2).mean((1, 3))
        w2 = np.ones(s // 2, np.float32)
        w2[0] = 0.5
        far = [(dy, dx) for dy in range(-6, 7, 2) for dx in range(-6, 7, 2) if max(abs(dy), abs(dx)) > NEAR]
        sbl2 = np.empty((len(far), sbh, sbw), np.float32)
        for j, (dy, dx) in enumerate(far):
            y0, x0 = r2 + dy // 2, r2 + dx // 2
            dl = L2[y0:y0 + h // 2, x0:x0 + s // 2] - Ls2
            dl *= dl
            dl *= w2
            sbl2[j] = dl.reshape(sbh, 2, sbw, 2).sum((1, 3)) * 4
        vecs = near + far
        vid = np.array([(dy + R) * NMV + dx + R for dy, dx in vecs])
        allv = np.concatenate([sbl, sbl2])
        allv = np.nan_to_num(allv, nan=np.inf)
        mbl = allv.reshape(len(vecs), mbh, 2, mbw, 2).sum((2, 4))
        K = 4
        cand_mb = vid[np.argpartition(mbl + lam * bmv[vid][:, None, None], K, 0)[:K]]
        cand_sb = vid[np.argpartition(allv + lam * bmv4[vid][:, None, None], K, 0)[:K]]
        # refinement: ±1 around the best coarse macroblock vector
        bestc = cand_mb[0]
        ref = []
        for ddy in (-1, 0, 1):
            for ddx in (-1, 0, 1):
                if ddy or ddx:
                    vy = np.clip(bestc // NMV - R + ddy, -R, R)
                    vx = np.clip(bestc % NMV - R + ddx, -R, R)
                    ref.append((vy + R) * NMV + vx + R)
        cand_mb = np.concatenate([cand_mb, np.stack(ref)])
        zero = R * NMV + R
        cand_mb = np.where(cand_mb == zero, cand_mb[0], cand_mb)

        def exact(cand, b, nby, nbx, bits):
            """Exact colour error for candidate vectors; best one including bit cost."""
            by = np.arange(nby)[None, :, None, None, None] * b
            bx = np.arange(nbx)[None, None, :, None, None] * b
            rr = np.arange(b)[None, None, None, :, None]
            cc = np.arange(b)[None, None, None, None, :]
            vy = (cand // NMV - R)[..., None, None]
            vx = (cand % NMV - R)[..., None, None]
            blk = Ppad[R + by + vy + rr, R + bx + vx + cc]  # (K, nby, nbx, b, b, 3)
            tgt = src.reshape(nby, b, nbx, b, 3).transpose(0, 2, 1, 3, 4)[None]
            ww = np.broadcast_to(w, (h, s)).reshape(nby, b, nbx, b).transpose(0, 2, 1, 3)[None]
            e = (((blk - tgt) ** 2).sum(-1) * ww).sum((-1, -2))
            e = np.nan_to_num(e, nan=np.inf) + lam * bits[cand]
            k = e.argmin(0)
            best = np.take_along_axis(e, k[None], 0)[0]
            v = np.take_along_axis(cand, k[None], 0)[0]
            return best, np.stack([v % NMV - R, v // NMV - R], -1)

        best_mb, best_mb_v = exact(cand_mb, 8, mbh, mbw, bmv)
        best_sb, best_sb_v = exact(cand_sb, 4, sbh, sbw, bmv4)
        e0 = (((Pp - src) ** 2).sum(-1)) * w
        skip_sb = blocksum(e0, 4)
        skip_mb = skip_sb.reshape(mbh, 2, mbw, 2).sum((1, 3))

        # fill: error for every palette colour from per-block sums
        P2 = (P ** 2).sum(-1)
        xw = src * w[..., None]

        def fill_cost(b):
            S0 = blocksum(np.broadcast_to(w, (h, s)).astype(np.float32), b)
            S1 = np.stack([blocksum(xw[..., k], b) for k in range(3)], -1)
            S2 = blocksum(((src ** 2).sum(-1)) * w, b)
            err = S2[..., None] - 2 * S1 @ P.T + S0[..., None] * P2[None, None]
            c = err.argmin(-1)
            return np.take_along_axis(err, c[..., None], -1)[..., 0], c

        fill_mb_e, fill_mb_c = fill_cost(8)
        fill_sb_e, fill_sb_c = fill_cost(4)
        b_fill = st.avg_bits("fill")

        # 4x4 blocks as (N,16,3). PAT and RAW are expensive to fit, so they are
        # only tried where SKIP and MV are noticeably wrong — in a static picture
        # that is a few percent of blocks
        sbt = st.bits("sbt0") * 0.5 + st.bits("sbt1") * 0.5
        N = sbh * sbw
        X = src.reshape(sbh, 4, sbw, 4, 3).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 3)
        Wt = np.broadcast_to(w, (h, s)).reshape(sbh, 4, sbw, 4).transpose(0, 2, 1, 3).reshape(-1, 16)
        cheap = np.minimum(skip_sb.reshape(N), best_sb.reshape(N))
        act = np.nonzero(cheap > lam * 6)[0]
        pat_e = np.full(N, np.inf)
        pat_a = np.zeros(N, np.int64)
        pat_b = np.zeros(N, np.int64)
        pat_m = np.zeros(N, np.int64)
        raw_e = np.full(N, np.inf)
        raw_c = np.zeros((N, 16), np.int64)
        if len(act):
            Xa, Wa = X[act], Wt[act]
            pe, pa_, pb_, pm = self.fit_pat(Xa, Wa, P, st, lam)
            pat_e[act], pat_a[act], pat_b[act], pat_m[act] = pe, pa_, pb_, pm
            raw_d = (Xa ** 2).sum(-1)[..., None] - 2 * Xa @ P.T + (P ** 2).sum(-1)  # (n,16,256)
            rc = raw_d.argmin(-1)
            raw_c[act] = rc
            raw_e[act] = (np.take_along_axis(raw_d, rc[..., None], -1)[..., 0] * Wa).sum(-1)
        b_raw = 16 * st.avg_bits("raw")

        cand = np.stack([
            skip_sb.reshape(N) + lam * sbt[SB_SKIP],
            best_sb.reshape(N) + lam * sbt[SB_MV],
            fill_sb_e.reshape(N) + lam * (sbt[SB_FILL] + b_fill),
            pat_e + lam * sbt[SB_PAT],
            raw_e + lam * (sbt[SB_RAW] + b_raw),
        ], -1)
        sb_mode = cand.argmin(-1)
        sb_cost = cand.min(-1).reshape(sbh, sbw)

        mbt = sum(st.bits(f"mbt{i}") for i in range(4)) / 4
        split = sb_cost.reshape(mbh, 2, mbw, 2).sum((1, 3)) + lam * mbt[MB_SPLIT]
        mcand = np.stack([
            skip_mb + lam * mbt[MB_SKIP],
            best_mb + lam * mbt[MB_MV],
            fill_mb_e + lam * (mbt[MB_FILL] + b_fill),
            split,
        ], -1)
        mb_mode = mcand.argmin(-1)
        return dict(mb_mode=mb_mode, mb_v=best_mb_v, mb_c=fill_mb_c,
                    sb_mode=sb_mode.reshape(sbh, sbw), sb_v=best_sb_v, sb_c=fill_sb_c.reshape(sbh, sbw),
                    pat_a=pat_a.reshape(sbh, sbw), pat_b=pat_b.reshape(sbh, sbw), pat_m=pat_m.reshape(sbh, sbw),
                    raw_c=raw_c.reshape(sbh, sbw, 16))

    def fit_pat(self, X, Wt, P, st, lam):
        """Two colours per 4x4 block: 2-means, then the best pair among the nearest palette colours."""
        L = X[..., 0]
        med = np.median(L, 1, keepdims=True)
        m = L > med
        for _ in range(2):
            wa = Wt * (~m)
            wb = Wt * m
            ca = (X * wa[..., None]).sum(1) / np.maximum(wa.sum(1), 1e-6)[:, None]
            cb = (X * wb[..., None]).sum(1) / np.maximum(wb.sum(1), 1e-6)[:, None]
            m = ((X - cb[:, None]) ** 2).sum(-1) < ((X - ca[:, None]) ** 2).sum(-1)
        K = 2
        P2 = (P ** 2).sum(-1)
        da = P2[None] - 2 * ca @ P.T
        db = P2[None] - 2 * cb @ P.T
        na = np.argpartition(da, K, 1)[:, :K]
        nb = np.argpartition(db, K, 1)[:, :K]
        pa = np.repeat(na, K, 1)  # (N,K*K)
        pb = np.tile(nb, (1, K))
        ea = ((X[:, None] - P[pa][:, :, None]) ** 2).sum(-1)  # (N,K*K,16)
        eb = ((X[:, None] - P[pb][:, :, None]) ** 2).sum(-1)
        useb = eb < ea
        err = (np.minimum(ea, eb) * Wt[:, None]).sum(-1)
        # mask bits from real statistics (after normalisation bit 0 is colour A)
        mask = (useb * (1 << np.arange(16))).sum(-1)
        flip = (mask & 1) == 1
        mask = np.where(flip, mask ^ 0xFFFF, mask)
        b0, b1 = st.bits("mask0"), st.bits("mask1")
        bits_m = b0[mask & 255] + b1[mask >> 8]
        bits_c = st.avg_bits("pata") + st.avg_bits("patb")
        cost = err + lam * (bits_m + bits_c)
        k = cost.argmin(1)
        idx = np.arange(len(X))
        a = np.where(flip[idx, k], pb[idx, k], pa[idx, k])
        b = np.where(flip[idx, k], pa[idx, k], pb[idx, k])
        return cost[idx, k], a, b, mask[idx, k]

    # ── frame reconstruction and symbols (exactly as on the watch) ──
    def build(self, prev, d):
        s, h = self.s, self.h
        mbw, mbh = s // 8, h // 8
        cur = prev.copy()
        flat = cur.reshape(-1)
        syms = []
        prev_sb_skip = True
        mtype = np.zeros((mbh, mbw), np.int64)

        def pred(off):
            return int(flat[off - 1]) if off else 0

        for my in range(mbh):
            for mx in range(mbw):
                t = int(d["mb_mode"][my, mx])
                mtype[my, mx] = t
                ls = 1 if mx == 0 or mtype[my, mx - 1] == MB_SKIP else 0
                ts = 1 if my == 0 or mtype[my - 1, mx] == MB_SKIP else 0
                syms.append((CI[f"mbt{ls * 2 + ts}"], t))
                y0, x0 = my * 8, mx * 8
                if t == MB_MV:
                    dx, dy = (int(v) for v in d["mb_v"][my, mx])
                    syms.append((CI["mv"], (dy + R) * NMV + dx + R))
                    cur[y0:y0 + 8, x0:x0 + 8] = prev[y0 + dy:y0 + dy + 8, x0 + dx:x0 + dx + 8]
                elif t == MB_FILL:
                    c = int(d["mb_c"][my, mx])
                    syms.append((CI["fill"], (c - pred(y0 * s + x0)) & 255))
                    cur[y0:y0 + 8, x0:x0 + 8] = c
                elif t == MB_SPLIT:
                    for k in range(4):
                        sy, sx = my * 2 + (k >> 1), mx * 2 + (k & 1)
                        st_ = int(d["sb_mode"][sy, sx])
                        syms.append((CI["sbt0" if prev_sb_skip else "sbt1"], st_))
                        prev_sb_skip = st_ == SB_SKIP
                        y, x = sy * 4, sx * 4
                        off = y * s + x
                        if st_ == SB_MV:
                            dx, dy = (int(v) for v in d["sb_v"][sy, sx])
                            syms.append((CI["mv4"], (dy + R) * NMV + dx + R))
                            cur[y:y + 4, x:x + 4] = prev[y + dy:y + dy + 4, x + dx:x + dx + 4]
                        elif st_ == SB_FILL:
                            c = int(d["sb_c"][sy, sx])
                            syms.append((CI["fill"], (c - pred(off)) & 255))
                            cur[y:y + 4, x:x + 4] = c
                        elif st_ == SB_PAT:
                            a, b, m = int(d["pat_a"][sy, sx]), int(d["pat_b"][sy, sx]), int(d["pat_m"][sy, sx])
                            syms += [(CI["pata"], (a - pred(off)) & 255), (CI["patb"], (b - a) & 255),
                                     (CI["mask0"], m & 255), (CI["mask1"], m >> 8)]
                            bits = ((m >> np.arange(16)) & 1).reshape(4, 4).astype(bool)
                            cur[y:y + 4, x:x + 4] = np.where(bits, b, a)
                        elif st_ == SB_RAW:
                            p = pred(off)
                            cc = d["raw_c"][sy, sx]
                            for i in range(16):
                                c = int(cc[i])
                                syms.append((CI["raw"], (c - p) & 255))
                                p = c
                            cur[y:y + 4, x:x + 4] = cc.reshape(4, 4)
        cur[:, 0] = 0
        return cur, syms

    # ── whole video ──
    def encode(self, frames_rgb, fps, audio=b"", log=None, kbps=None):
        """
        frames_rgb: (n, h, s-1, 3) uint8. Returns the .zv bytes, reconstructed
        frames and the palette. kbps — target video rate in kilobytes/s: λ is
        adjusted per frame so a heavy clip does not bloat and a light one is not
        blurred for nothing. Without kbps λ stays constant (self.lam).
        """
        s, h = self.s, self.h
        n = len(frames_rgb)
        work = srgb_to_work(frames_rgb)
        pal_rgb, P = make_palette(work)
        src = np.zeros((n, h, s, 3), np.float32)
        src[:, :, 1:] = work
        st = Stats()
        prev = np.zeros((h, s), np.uint8)
        all_syms, recon = [], []
        lam = self.lam
        target = kbps * 8192 / fps if kbps else None  # bits per frame
        spent = budget = 0.0
        diffs = []
        for i in range(n):
            # the first frame is built from scratch — give it more bits, otherwise
            # the video starts with big squares
            li = lam * (self.intra if i == 0 else 1.0)
            if i > 0:
                # scene cut: the old frame does not help, the new one is built almost
                # from scratch — give it more bits, the rate control catches up later
                dl = float(np.abs(src[i, :, 1:, 0] - src[i - 1, :, 1:, 0]).mean())
                if dl > 18 and dl > 2.5 * float(np.median(diffs[-24:] or [dl])):
                    li = lam * 0.5
                diffs.append(dl)
            d = self.decide(prev, src[i], P, st, li)
            cur, syms = self.build(prev, d)
            if target:
                bits = st.cost(syms)
                spent += bits
                budget += target * (4 if i == 0 else 1)  # headroom for the first frame
                # overspend in seconds of stream → λ doubles every half second
                over = (spent - budget) / (target * fps)
                lam = float(np.clip(self.lam * 2 ** (over * 2.0), self.lam / 8, self.lam * 16))
                if i > 0:
                    # and slowly learn the average λ this clip needs
                    self.lam = float(np.clip(self.lam * (bits / target) ** 0.08, 2, 2000))
            st.add(syms)
            all_syms.append(syms)
            recon.append(cur)
            prev = cur
            if log and i % 12 == 0:
                log(i + 1, n)
        counts = [np.zeros(a, np.int64) for _, a in CTX]
        for syms in all_syms:
            for ctx, sy in syms:
                counts[ctx][sy] += 1
        tables = Tables([normalize_freqs(c) for c in counts])
        prefix, suffix, zhead = png_parts(s, h, pal_rgb)
        frames_data = []
        for cur, syms in zip(recon, all_syms):
            frames_data.append(frame_sums(zhead, cur.tobytes()) + rans_encode(syms, tables))
        blob = pack(s, h, fps, prefix, tables, frames_data, audio)
        return blob, recon, pal_rgb


def pack(s, h, fps, prefix, tables, frames_data, audio):
    """
    .zv file (numbers little-endian), see docs/FORMAT.md:
      0  'ZVV1'
      4  u16 S (row stride), u16 H, u16 fps×100, u16 frame count N
      12 u32 audio offset, u32 audio length (mp3, may be 0)
      20 u32 start of frame data (everything before it is the header, read at once)
      24 u16 PNG prefix length, then the PNG prefix itself
         rANS tables (per context: u16 count, then u8 symbol + u16 freq−1)
         u32 × (N+1) — frame offsets from the start of the file
         frames: 8 bytes Adler-32+CRC32 (big-endian, as in PNG), then the rANS stream
         audio
    """
    n = len(frames_data)
    tbl = tables.serialize()
    head = MAGIC + struct.pack("<HHHH", s, h, int(round(fps * 100)), n)
    fixed = 4 + 8 + 8 + 4 + 2
    index_at = fixed + len(prefix) + len(tbl)
    data_at = index_at + 4 * (n + 1)
    offs = [data_at]
    for f in frames_data:
        offs.append(offs[-1] + len(f))
    audio_at = offs[-1]
    out = bytearray(head)
    out += struct.pack("<II", audio_at if audio else 0, len(audio))
    out += struct.pack("<I", data_at)
    out += struct.pack("<H", len(prefix)) + prefix + tbl
    out += b"".join(struct.pack("<I", o) for o in offs)
    for f in frames_data:
        out += f
    out += audio
    return bytes(out)


# ───────────────────────────── reference decoder ─────────────────────────────

def parse(blob):
    assert blob[:4] == MAGIC
    s, h, fps100, n = struct.unpack_from("<HHHH", blob, 4)
    audio_at, audio_len = struct.unpack_from("<II", blob, 12)
    (plen,) = struct.unpack_from("<H", blob, 24)
    prefix = blob[26:26 + plen]
    tables, pos = Tables.parse(blob, 26 + plen)
    offs = struct.unpack_from(f"<{n + 1}I", blob, pos)
    return dict(s=s, h=h, fps=fps100 / 100, n=n, prefix=prefix, tables=tables, offs=offs,
                audio=blob[audio_at:audio_at + audio_len] if audio_len else b"")


def decode(blob):
    """Frames exactly as the watch builds them (s×h index buffers). Verifies checksums."""
    v = parse(blob)
    s, h = v["s"], v["h"]
    mbw, mbh = s // 8, h // 8
    prev = np.zeros((h, s), np.uint8)
    zhead = v["prefix"][-7:]
    out = []
    for i in range(v["n"]):
        a, b = v["offs"][i], v["offs"][i + 1]
        sums = blob[a:a + 8]
        dec = RansDecoder(blob[a + 8:b], v["tables"])
        cur = prev.copy()
        flat = cur.reshape(-1)
        mtype = np.zeros((mbh, mbw), np.int64)
        prev_sb_skip = True

        def pred(off):
            return int(flat[off - 1]) if off else 0

        for my in range(mbh):
            for mx in range(mbw):
                ls = 1 if mx == 0 or mtype[my, mx - 1] == MB_SKIP else 0
                ts = 1 if my == 0 or mtype[my - 1, mx] == MB_SKIP else 0
                t = dec.get(ls * 2 + ts)
                mtype[my, mx] = t
                y0, x0 = my * 8, mx * 8
                if t == MB_MV:
                    mv = dec.get(CI["mv"])
                    dx, dy = mv % NMV - R, mv // NMV - R
                    cur[y0:y0 + 8, x0:x0 + 8] = prev[y0 + dy:y0 + dy + 8, x0 + dx:x0 + dx + 8]
                elif t == MB_FILL:
                    c = (dec.get(CI["fill"]) + pred(y0 * s + x0)) & 255
                    cur[y0:y0 + 8, x0:x0 + 8] = c
                elif t == MB_SPLIT:
                    for k in range(4):
                        sy, sx = my * 2 + (k >> 1), mx * 2 + (k & 1)
                        st_ = dec.get(CI["sbt0" if prev_sb_skip else "sbt1"])
                        prev_sb_skip = st_ == SB_SKIP
                        y, x = sy * 4, sx * 4
                        off = y * s + x
                        if st_ == SB_MV:
                            mv = dec.get(CI["mv4"])
                            dx, dy = mv % NMV - R, mv // NMV - R
                            cur[y:y + 4, x:x + 4] = prev[y + dy:y + dy + 4, x + dx:x + dx + 4]
                        elif st_ == SB_FILL:
                            cur[y:y + 4, x:x + 4] = (dec.get(CI["fill"]) + pred(off)) & 255
                        elif st_ == SB_PAT:
                            a_ = (dec.get(CI["pata"]) + pred(off)) & 255
                            b_ = (dec.get(CI["patb"]) + a_) & 255
                            m = dec.get(CI["mask0"]) | (dec.get(CI["mask1"]) << 8)
                            bits = ((m >> np.arange(16)) & 1).reshape(4, 4).astype(bool)
                            cur[y:y + 4, x:x + 4] = np.where(bits, b_, a_)
                        elif st_ == SB_RAW:
                            p = pred(off)
                            cc = []
                            for _ in range(16):
                                p = (dec.get(CI["raw"]) + p) & 255
                                cc.append(p)
                            cur[y:y + 4, x:x + 4] = np.array(cc, np.uint8).reshape(4, 4)
        cur[:, 0] = 0
        got = frame_sums(zhead, cur.tobytes())
        assert got == sums, f"frame {i}: checksum mismatch"
        out.append(cur)
        prev = cur
    return v, out
