// Check the watch decoder on a computer: node tools/zvtest.mjs video.zv [frame.png index]
// Compares the Adler-32 of every decoded frame with the one the encoder stored,
// optionally saves frame <index> as the exact PNG file the watch would write.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseHeader, headerSize, createDecoder } from '../watch/lib/zv.js'

const file = readFileSync(process.argv[2])
const u8 = new Uint8Array(file.buffer, file.byteOffset, file.length)
const head = u8.subarray(0, headerSize(u8))
const v = parseHeader(head)
const dec = createDecoder(v)
const SH = v.S * v.H
function adler(b, a0, n) {
  let a = 1, s = 0
  for (let i = 0; i < n; i++) { a = (a + b[a0 + i]) % 65521; s = (s + a) % 65521 }
  return ((s << 16) | a) >>> 0
}
let t = performance.now(), bad = 0
for (let i = 0; i < v.n; i++) {
  const bytes = u8.subarray(v.offs[i], v.offs[i + 1])
  dec.decode(bytes)
  const want = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  const got = adler(dec.bytes, dec.curOff, SH)
  if (got !== want) { bad++; if (bad < 5) console.log('frame', i, 'mismatch') }
  if (process.argv[3] && i === Number(process.argv[4] || 0)) {
    writeFileSync(process.argv[3], dec.bytes.subarray(dec.fileAt, dec.fileAt + dec.fileLen))
  }
  dec.commit()
}
console.log(`${v.n} frames ${v.S - 1}x${v.H} @ ${v.fps} fps, mismatches ${bad}, ${(performance.now() - t).toFixed(0)} ms`)
