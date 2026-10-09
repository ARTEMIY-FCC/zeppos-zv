// Decoder speed in QuickJS (the engine the watch runs): qjs --std tools/zvbench.mjs video.zv
import * as std from 'std'
import { parseHeader, headerSize, createDecoder } from '../watch/lib/zv.js'

const path = scriptArgs[1]
const f = std.open(path, 'rb')
f.seek(0, std.SEEK_END)
const size = f.tell()
f.seek(0, std.SEEK_SET)
const u8 = new Uint8Array(size)
f.read(u8.buffer, 0, size)
f.close()
let t = Date.now()
const v = parseHeader(u8.subarray(0, headerSize(u8)))
const tHead = Date.now() - t
const dec = createDecoder(v)
t = Date.now()
for (let i = 0; i < v.n; i++) {
  dec.decode(u8.subarray(v.offs[i], v.offs[i + 1]))
  dec.commit()
}
const tDec = Date.now() - t
print(`${path.split('/').pop()}: header ${tHead} ms, ${v.n} frames in ${tDec} ms, ${(tDec / v.n).toFixed(2)} ms/frame`)
