/**
 * ZV — video decoder for Zepp OS watches (the format is produced by encoder/zv.py,
 * see docs/FORMAT.md).
 *
 * The watch displays PNG files by itself, it only needs a file. So a frame is
 * assembled directly as the bytes of an uncompressed PNG (deflate "stored"):
 * one ArrayBuffer holds the previous frame, the PNG head, the current frame
 * and the PNG tail, and a finished frame goes to a file with a single
 * writeSync. PNG checksums come from the encoder — computing them here would
 * cost more than the frame itself.
 *
 * A buffer row is S bytes: the PNG filter byte (0) and S-1 visible pixels
 * (palette indices). S is a multiple of 4, so 4x4 fills and patterns are
 * written as one Uint32Array word per row — on the watch every JS step is
 * expensive, memory is not. Motion copies are copyWithin inside the same buffer.
 *
 * A frame is 8x8 macroblocks: skip / motion copy / fill / four 4x4 blocks
 * (skip / motion copy / fill / two colours by mask / 16 colours). Symbols are
 * rANS-coded with static per-video tables.
 */

const MAGIC = 0x3156565a // 'ZVV1'
const R = 7
const PROB_BITS = 12
const PROB_MASK = 4095
const RANS_L = 8388608 // 1 << 23

// contexts — same order as CTX in the encoder
const C_MBT = 0 // 0..3
const C_SBT0 = 4
const C_SBT1 = 5
const C_MV = 6 // motion vector as one symbol: (dy+R)*15 + dx+R
const C_MV4 = 7
const C_FILL = 8
const C_PATA = 9
const C_PATB = 10
const C_MASK0 = 11
const C_MASK1 = 12
const C_RAW = 13
const NMV = 2 * R + 1
const ALPHA = [4, 4, 4, 4, 5, 5, NMV * NMV, NMV * NMV, 256, 256, 256, 256, 256, 256]

// 4-pixel row mask → word whose bytes are 0xFF for the selected pixels
const NIB = new Uint32Array(16)
for (let n = 0; n < 16; n++) {
  let w = 0
  for (let c = 0; c < 4; c++) if (n & (1 << c)) w += 0xff * Math.pow(256, c)
  NIB[n] = w
}

function u16(b, p) {
  return b[p] | (b[p + 1] << 8)
}
function u32(b, p) {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 16777216
}

/**
 * Header size: read the first 26 bytes of the file, headerSize() tells how
 * many bytes parseHeader() needs.
 */
export function headerSize(head) {
  if (u32(head, 0) !== MAGIC) throw new Error('not a ZV file')
  return u32(head, 20)
}

export function parseHeader(head) {
  if (u32(head, 0) !== MAGIC) throw new Error('not a ZV file')
  const v = {
    S: u16(head, 4),
    H: u16(head, 6),
    fps: u16(head, 8) / 100,
    n: u16(head, 10),
    audioAt: u32(head, 12),
    audioLen: u32(head, 16),
    dataAt: u32(head, 20),
  }
  const plen = u16(head, 24)
  v.prefix = head.subarray(26, 26 + plen)
  let p = 26 + plen
  // rANS tables: per slot — symbol | (freq−1) << 8 | symbol start << 20.
  // The value is the same over the whole symbol range, so it is written with
  // fill() instead of a loop: a per-element loop over 64K slots takes seconds
  // on the watch
  const tab = new Uint32Array(ALPHA.length * 4096)
  for (let c = 0; c < ALPHA.length; c++) {
    const cnt = u16(head, p)
    p += 2
    let cum = 0
    const base = c * 4096
    for (let k = 0; k < cnt; k++, p += 3) {
      const f = u16(head, p + 1) + 1
      tab.fill(head[p] + (f - 1) * 256 + cum * 1048576, base + cum, base + cum + f)
      cum += f
    }
    if (cnt === 0) tab.fill(4095 * 256, base, base + 4096)
  }
  v.tab = tab
  v.offs = new Array(v.n + 1)
  for (let i = 0; i <= v.n; i++) v.offs[i] = u32(head, p + 4 * i)
  return v
}

/**
 * Frame decoder. After decode(bytes) the finished PNG file is
 * dec.buffer[dec.fileAt, dec.fileAt + dec.fileLen).
 */
export function createDecoder(v) {
  const S = v.S
  const H = v.H
  const SH = S * H
  const W4 = S >> 2
  const plen = v.prefix.length
  const SUFFIX = 20 // adler + crc + IEND
  // [previous frame][...PNG head][current frame][tail]; current starts at a multiple of 4
  let curOff = SH + plen
  curOff = (curOff + 3) & ~3
  const total = curOff + SH + SUFFIX
  const mem = new ArrayBuffer(total)
  const b = new Uint8Array(mem)
  const w = new Uint32Array(mem)
  const fileAt = curOff - plen
  b.set(v.prefix, fileAt)
  // IEND
  const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82]
  for (let i = 0; i < 12; i++) b[curOff + SH + 8 + i] = iend[i]
  const tab = v.tab
  const mbw = S >> 3
  const mbh = H >> 3
  const above = new Uint8Array(mbw) // is the macroblock above skipped
  // motion symbol → buffer offset
  const mvoff = new Int32Array(NMV * NMV)
  for (let i = 0; i < NMV * NMV; i++) mvoff[i] = (Math.floor(i / NMV) - R) * S + (i % NMV) - R

  function decode(bytes) {
    // rANS state — the first 4 bytes after the 8 checksum bytes
    let p = 8
    let x = bytes[p] * 16777216 + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3]
    p += 4
    let e = 0
    let sbSkip = 1
    above.fill(1)
    for (let my = 0; my < mbh; my++) {
      let leftSkip = 1
      for (let mx = 0; mx < mbw; mx++) {
        // macroblock type
        e = tab[((leftSkip << 1) | above[mx]) * 4096 + (x & PROB_MASK)]
        x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
        if (x < RANS_L) {
          x = (x << 8) | bytes[p++]
          if (x < RANS_L) x = (x << 8) | bytes[p++]
        }
        const t = e & 255
        const skip = t === 0 ? 1 : 0
        leftSkip = skip
        above[mx] = skip
        if (skip) continue
        const y0 = my << 3
        const x0 = mx << 3
        const off = y0 * S + x0
        if (t === 1) {
          // 8x8 motion copy
          e = tab[C_MV * 4096 + (x & PROB_MASK)]
          x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
          if (x < RANS_L) {
            x = (x << 8) | bytes[p++]
            if (x < RANS_L) x = (x << 8) | bytes[p++]
          }
          let src = off + mvoff[e & 255]
          let dst = curOff + off
          for (let r = 0; r < 8; r++, src += S, dst += S) b.copyWithin(dst, src, src + 8)
        } else if (t === 2) {
          // 8x8 fill
          e = tab[C_FILL * 4096 + (x & PROB_MASK)]
          x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
          if (x < RANS_L) {
            x = (x << 8) | bytes[p++]
            if (x < RANS_L) x = (x << 8) | bytes[p++]
          }
          const c = ((e & 255) + (off ? b[curOff + off - 1] : 0)) & 255
          const c32 = c * 0x01010101
          let i = (curOff + off) >> 2
          for (let r = 0; r < 8; r++, i += W4) {
            w[i] = c32
            w[i + 1] = c32
          }
        } else {
          // four 4x4 blocks
          for (let k = 0; k < 4; k++) {
            e = tab[(sbSkip ? C_SBT0 : C_SBT1) * 4096 + (x & PROB_MASK)]
            x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
            if (x < RANS_L) {
              x = (x << 8) | bytes[p++]
              if (x < RANS_L) x = (x << 8) | bytes[p++]
            }
            const st = e & 255
            sbSkip = st === 0 ? 1 : 0
            if (sbSkip) continue
            const so = off + (k >> 1) * 4 * S + (k & 1) * 4
            if (st === 1) {
              e = tab[C_MV4 * 4096 + (x & PROB_MASK)]
              x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
              if (x < RANS_L) {
                x = (x << 8) | bytes[p++]
                if (x < RANS_L) x = (x << 8) | bytes[p++]
              }
              const src = so + mvoff[e & 255]
              const dst = curOff + so
              b.copyWithin(dst, src, src + 4)
              b.copyWithin(dst + S, src + S, src + S + 4)
              b.copyWithin(dst + 2 * S, src + 2 * S, src + 2 * S + 4)
              b.copyWithin(dst + 3 * S, src + 3 * S, src + 3 * S + 4)
            } else if (st === 2) {
              e = tab[C_FILL * 4096 + (x & PROB_MASK)]
              x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
              if (x < RANS_L) {
                x = (x << 8) | bytes[p++]
                if (x < RANS_L) x = (x << 8) | bytes[p++]
              }
              const c32 = (((e & 255) + (so ? b[curOff + so - 1] : 0)) & 255) * 0x01010101
              const i = (curOff + so) >> 2
              w[i] = c32
              w[i + W4] = c32
              w[i + 2 * W4] = c32
              w[i + 3 * W4] = c32
            } else if (st === 3) {
              // two colours by mask
              e = tab[C_PATA * 4096 + (x & PROB_MASK)]
              x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
              if (x < RANS_L) {
                x = (x << 8) | bytes[p++]
                if (x < RANS_L) x = (x << 8) | bytes[p++]
              }
              const a = ((e & 255) + (so ? b[curOff + so - 1] : 0)) & 255
              e = tab[C_PATB * 4096 + (x & PROB_MASK)]
              x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
              if (x < RANS_L) {
                x = (x << 8) | bytes[p++]
                if (x < RANS_L) x = (x << 8) | bytes[p++]
              }
              const bb = ((e & 255) + a) & 255
              e = tab[C_MASK0 * 4096 + (x & PROB_MASK)]
              x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
              if (x < RANS_L) {
                x = (x << 8) | bytes[p++]
                if (x < RANS_L) x = (x << 8) | bytes[p++]
              }
              const m0 = e & 255
              e = tab[C_MASK1 * 4096 + (x & PROB_MASK)]
              x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
              if (x < RANS_L) {
                x = (x << 8) | bytes[p++]
                if (x < RANS_L) x = (x << 8) | bytes[p++]
              }
              const m1 = e & 255
              const a32 = a * 0x01010101
              const x32 = (a ^ bb) * 0x01010101
              const i = (curOff + so) >> 2
              w[i] = a32 ^ (x32 & NIB[m0 & 15])
              w[i + W4] = a32 ^ (x32 & NIB[m0 >> 4])
              w[i + 2 * W4] = a32 ^ (x32 & NIB[m1 & 15])
              w[i + 3 * W4] = a32 ^ (x32 & NIB[m1 >> 4])
            } else {
              // 16 colours, each as a difference to the previous one
              let c = so ? b[curOff + so - 1] : 0
              let q = curOff + so
              for (let r = 0; r < 4; r++, q += S) {
                for (let cc = 0; cc < 4; cc++) {
                  e = tab[C_RAW * 4096 + (x & PROB_MASK)]
                  x = (((e >>> 8) & 4095) + 1) * (x >>> PROB_BITS) + (x & PROB_MASK) - (e >>> 20)
                  if (x < RANS_L) {
                    x = (x << 8) | bytes[p++]
                    if (x < RANS_L) x = (x << 8) | bytes[p++]
                  }
                  c = (c + (e & 255)) & 255
                  b[q + cc] = c
                }
              }
            }
          }
        }
      }
    }
    // PNG filter bytes must be 0 (blocks in the first column overwrote them)
    for (let y = 0, q = curOff; y < H; y++, q += S) b[q] = 0
    // Adler-32 and CRC32 from the encoder
    const t = curOff + SH
    for (let i = 0; i < 8; i++) b[t + i] = bytes[i]
  }

  return {
    buffer: mem,
    bytes: b,
    fileAt,
    fileLen: plen + SH + SUFFIX,
    curOff,
    /** Build the next frame from its bytes (frames strictly in order). */
    decode(bytes) {
      decode(bytes)
    },
    /** The frame has been written — it becomes the previous one. */
    commit() {
      b.copyWithin(0, curOff, curOff + SH)
    },
    /** Rewind: both frames zero (the encoder starts the same way). */
    reset() {
      b.fill(0, 0, SH)
      b.fill(0, curOff, curOff + SH)
    },
  }
}
