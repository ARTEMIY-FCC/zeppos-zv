// Install QR code for the watch: node tools/preview.mjs
//
// Runs `zeus preview` for watch/ on every device that matches app.json (screen
// shape and API level not below minVersion), catches the link that zeus only
// draws in the terminal and saves the QR code as preview/qr.png (link and
// expiry in preview/qr.txt). A zeus preview QR is valid for 7 days.
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APP = join(ROOT, 'watch')
const zeusBin = realpathSync(execSync('command -v zeus', { encoding: 'utf8', shell: '/bin/sh' }).trim())
const zeusRequire = createRequire(join(dirname(dirname(zeusBin)), 'package.json'))

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

function supportedDevices() {
  const app = JSON.parse(readFileSync(join(APP, 'app.json'), 'utf8'))
  const minApi = app.runtime.apiVersion.minVersion
  const shapes = new Set(Object.values(app.targets).flatMap((t) => (t.platforms || []).map((p) => p.st)))
  const utils = zeusRequire('./private-modules/zeppos-app-utils/dist/index.js')
  const { deviceTargets } = utils.config.getDeviceConf()
  return Object.values(deviceTargets)
    .filter((d) => shapes.has(d.screen?.type) && d.apiLevelLimit?.max && compareVersions(d.apiLevelLimit.max, minApi) >= 0)
    .map((d) => d.deviceName)
}

function writeQrPng(text, file) {
  const QRCode = zeusRequire('qrcode-terminal/vendor/QRCode')
  const levels = zeusRequire('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')
  const qr = new QRCode(-1, levels.M)
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const scale = 10
  const quiet = 4
  const size = (n + quiet * 2) * scale
  const row = size + 1
  const raw = Buffer.alloc(row * size, 255)
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0
    const my = Math.floor(y / scale) - quiet
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet
      if (my >= 0 && my < n && mx >= 0 && mx < n && qr.isDark(my, mx)) raw[y * row + 1 + x] = 0
    }
  }
  const crcTable = new Int32Array(256).map((_, k) => {
    let c = k
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c
  })
  const crc = (buf) => {
    let c = -1
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

const devices = supportedDevices()
const tmp = mkdtempSync(join(tmpdir(), 'zv-qr-'))
const urlFile = join(tmp, 'url.txt')
const hook = join(tmp, 'hook.cjs')
writeFileSync(
  hook,
  `const Module = require("module");
const load = Module._load;
Module._load = function (request) {
  const m = load.apply(this, arguments);
  if (request === "qrcode-terminal" && !m.__urlHook) {
    const generate = m.generate;
    m.generate = function (url) {
      require("fs").writeFileSync(${JSON.stringify(urlFile)}, url);
      return generate.apply(this, arguments);
    };
    m.__urlHook = true;
  }
  return m;
};
`,
)
const args = ['--require', hook, zeusBin, 'preview', ...(devices.length ? ['-s', '-t', devices.join(',')] : [])]
const status = await new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: APP, stdio: 'inherit' })
  child.on('exit', (code) => resolve(code ?? 1))
})
if (existsSync(urlFile)) {
  const url = readFileSync(urlFile, 'utf8').trim()
  const outDir = join(ROOT, 'preview')
  mkdirSync(outDir, { recursive: true })
  writeQrPng(url, join(outDir, 'qr.png'))
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000)
  const two = (x) => String(x).padStart(2, '0')
  writeFileSync(
    join(outDir, 'qr.txt'),
    `${url}\nvalid until ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}\n` +
      `devices: ${devices.join(', ')}\n`,
  )
  console.log('\nQR: ' + relative(process.cwd(), join(outDir, 'qr.png')))
}
rmSync(tmp, { recursive: true, force: true })
process.exit(status)
